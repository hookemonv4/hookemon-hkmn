import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const unsafeUnicodePattern = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const catalogKeys = ["entries", "kind", "mandatoryPacks", "policy", "schemaVersion"];
const policyKeys = [
  "automaticAdverseDecision",
  "missingCatalogLabelOutcome",
  "selectionSemantics",
  "unknownCapabilityOutcome"
];
const entryKeys = ["id", "kind", "path", "sha256"];
const starterKeys = [
  "acceleratorOnly",
  "capabilities",
  "conflictsWith",
  "defaultPacks",
  "eligibilityEffect",
  "id",
  "kind",
  "label",
  "projectSurfaces",
  "requiredFacts",
  "requiredFiles",
  "requiredTests",
  "reviewRoute",
  "risks",
  "schemaVersion",
  "summary",
  "unknownCapabilityPolicy"
];
const packKeys = [
  "acceleratorOnly",
  "capabilities",
  "conflictsWith",
  "eligibilityEffect",
  "id",
  "kind",
  "label",
  "projectSurfaces",
  "requiredFacts",
  "requiredFiles",
  "requiredTests",
  "requires",
  "reviewRoute",
  "risks",
  "schemaVersion",
  "summary",
  "unknownCapabilityPolicy"
];
const reviewRoutes = new Set([
  "architecture-review-required",
  "custom-review",
  "standard-review"
]);

export class TemplateCatalogError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TemplateCatalogError";
    this.code = code;
    this.details = details;
  }
}

export function loadTemplateCatalog({ skillRoot = null, catalogDirectory = null } = {}) {
  if ((skillRoot === null) === (catalogDirectory === null)) {
    fail("CATALOG_LOCATION_INVALID", "Provide exactly one skillRoot or catalogDirectory.");
  }

  const directory = catalogDirectory === null
    ? path.join(path.resolve(skillRoot), "assets", "starter-catalog")
    : path.resolve(catalogDirectory);
  assertDirectory(directory, "catalog directory");

  const manifestPath = path.join(directory, "catalog.json");
  const { value: manifest, bytes: manifestBytes } = readJsonFile(manifestPath, 1_048_576);
  validateManifest(manifest);

  const definitions = [];
  const byId = new Map();
  for (const entry of manifest.entries) {
    const definitionPath = resolveCatalogPath(directory, entry.path);
    const { value: definition, bytes } = readJsonFile(definitionPath, 262_144);
    const actualHash = sha256(bytes);
    if (actualHash !== entry.sha256) {
      fail(
        "CATALOG_HASH_MISMATCH",
        `Catalog entry ${entry.id} has sha256 ${actualHash}, expected ${entry.sha256}.`,
        { id: entry.id, path: entry.path, expected: entry.sha256, actual: actualHash }
      );
    }
    validateDefinition(definition, entry);
    definitions.push(deepFreeze({ ...definition, definitionSha256: actualHash }));
    byId.set(entry.id, definitions.at(-1));
  }

  assertNoUnlistedDefinitions(directory, manifest.entries);
  validateCrossReferences(manifest, byId);

  const catalogDigest = domainHash("programmable.template-catalog.v1", canonicalJson(manifest));
  return deepFreeze({
    directory,
    manifest,
    manifestSha256: sha256(manifestBytes),
    catalogDigest,
    definitions,
    byId
  });
}

export function listTemplateCatalog(catalog, { kind = null } = {}) {
  if (kind !== null && kind !== "starter" && kind !== "pack") {
    fail("CATALOG_KIND_INVALID", "Catalog kind must be starter or pack.");
  }
  return catalog.definitions
    .filter((definition) => kind === null || definition.kind === kind)
    .map(({ id, kind: definitionKind, label, summary, reviewRoute, definitionSha256 }) => ({
      id,
      kind: definitionKind,
      label,
      summary,
      reviewRoute,
      definitionSha256
    }));
}

export function showTemplateDefinition(catalog, id) {
  assertId(id, "definition id");
  const definition = catalog.byId.get(id);
  if (!definition) fail("CATALOG_ENTRY_UNKNOWN", `Unknown catalog entry: ${id}.`, { id });
  return structuredClone(definition);
}

export function parseCustomCapability(value) {
  if (typeof value !== "string") {
    fail("CUSTOM_CAPABILITY_INVALID", "Custom capability must use <id>=<visible label>.");
  }
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    fail("CUSTOM_CAPABILITY_INVALID", "Custom capability must use <id>=<visible label>.");
  }
  const id = value.slice(0, separator);
  const label = value.slice(separator + 1);
  assertId(id, "custom capability id");
  assertSafeText(label, "custom capability label", { maximumBytes: 120 });
  return { id, label };
}

export function parseLocalTag(value) {
  assertLocalTag(value, "local tag");
  return value;
}

export function composeTemplate({
  catalog,
  starterId,
  packIds = [],
  customCapabilities = [],
  localTags = []
}) {
  assertId(starterId, "starter id");
  const starter = catalog.byId.get(starterId);
  if (!starter || starter.kind !== "starter") {
    fail("STARTER_UNKNOWN", `Unknown starter: ${starterId}.`, { starterId });
  }

  const requestedPackIds = normalizeRequestedIds(packIds, "pack id");
  const selected = new Set(starter.defaultPacks);
  for (const packId of requestedPackIds) {
    const definition = catalog.byId.get(packId);
    if (!definition || definition.kind !== "pack") {
      fail("PACK_UNKNOWN", `Unknown capability pack: ${packId}.`, { packId });
    }
    selected.add(packId);
  }

  const visit = (packId, stack = []) => {
    if (stack.includes(packId)) {
      fail("CATALOG_REQUIREMENT_CYCLE", `Capability-pack requirement cycle: ${[...stack, packId].join(" -> ")}.`);
    }
    const pack = catalog.byId.get(packId);
    for (const requiredId of pack.requires) {
      if (!selected.has(requiredId)) selected.add(requiredId);
      visit(requiredId, [...stack, packId]);
    }
  };
  for (const packId of [...selected]) visit(packId);

  const selectedPackIds = [...selected].sort(compareUtf8);
  if (["ordinary-launch", "custom-token-standard-fee-hook"].includes(starter.id) && selected.has("custom-hook-behavior")) {
    fail(
      "CUSTOM_HOOK_STARTER_REQUIRED",
      `${starter.id} cannot include custom-hook behavior directly or through another pack. Preserve the selected packs and continue with --starter custom-hook.`,
      {
        starterId: starter.id,
        recommendedStarterId: "custom-hook",
        selectedPackIds,
        adverseDecision: false,
        eligibilityEffect: "none"
      }
    );
  }
  const hasTokenSideSpecialBehavior = selectedPackIds.some(
    (id) => catalog.byId.get(id).capabilities.includes("token-side-special-behavior")
  );
  if (starter.id === "ordinary-launch" && hasTokenSideSpecialBehavior) {
    fail(
      "CUSTOM_TOKEN_STARTER_REQUIRED",
      "ordinary-launch cannot include token-side special behavior. Preserve the selected packs and continue with --starter custom-token-standard-fee-hook.",
      {
        starterId: starter.id,
        recommendedStarterId: "custom-token-standard-fee-hook",
        selectedPackIds,
        adverseDecision: false,
        eligibilityEffect: "none"
      }
    );
  }
  const selectedIds = [starterId, ...selectedPackIds];
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < selectedIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectedIds.length; rightIndex += 1) {
      const left = catalog.byId.get(selectedIds[leftIndex]);
      const right = catalog.byId.get(selectedIds[rightIndex]);
      if (left.conflictsWith.includes(right.id) || right.conflictsWith.includes(left.id)) {
        conflicts.push([left.id, right.id]);
      }
    }
  }
  if (conflicts.length > 0) {
    fail(
      "TEMPLATE_COMPOSITION_CONFLICT",
      `Selected templates conflict: ${conflicts.map(([left, right]) => `${left} + ${right}`).join(", ")}. Choose a different starter or pack composition; this is not a safety or eligibility decision.`,
      { conflicts, adverseDecision: false, eligibilityEffect: "none" }
    );
  }

  const catalogCapabilityIds = new Set(
    catalog.definitions.flatMap((definition) => definition.capabilities)
  );
  const normalizedCustomCapabilities = normalizeCustomCapabilities(customCapabilities);
  const normalizedLocalTags = normalizeLocalTags(localTags);
  for (const custom of normalizedCustomCapabilities) {
    if (catalogCapabilityIds.has(custom.id)) {
      fail(
        "CUSTOM_CAPABILITY_ALREADY_KNOWN",
        `Custom capability ${custom.id} already has a catalog capability label. Select the matching pack or use a distinct owner-defined id.`,
        { id: custom.id }
      );
    }
  }

  const autoIncludedPackIds = selectedPackIds.filter(
    (id) => !starter.defaultPacks.includes(id) && !requestedPackIds.includes(id)
  );
  const selectionPreimage = {
    schemaVersion: "1.0.0",
    catalogDigest: catalog.catalogDigest,
    starterId,
    requestedPackIds,
    selectedPackIds,
    customCapabilities: normalizedCustomCapabilities.map(({ id, label }) => ({ id, label })),
    localTags: normalizedLocalTags
  };
  const selectionDigest = domainHash(
    "programmable.template-selection.v1",
    canonicalJson(selectionPreimage)
  );
  const knownCapabilityIds = [...new Set([
    ...starter.capabilities,
    ...selectedPackIds.flatMap((id) => catalog.byId.get(id).capabilities)
  ])].sort(compareUtf8);
  const ownerDefinedCapabilityIds = normalizedCustomCapabilities.map(({ id }) => id);
  const allCapabilityIds = [...new Set([...knownCapabilityIds, ...ownerDefinedCapabilityIds])].sort(compareUtf8);

  return {
    schemaVersion: "1.0.0",
    kind: "programmable-project-template",
    catalogDigest: catalog.catalogDigest,
    selectionDigest,
    policy: {
      selectionSemantics: "accelerator-only",
      eligibilityEffect: "none",
      unknownCapabilityOutcome: "architecture-review-required",
      missingCatalogLabelOutcome: "preserve-custom-capability",
      automaticAdverseDecision: false
    },
    selection: {
      starterId,
      requestedPackIds,
      defaultPackIds: [...starter.defaultPacks],
      autoIncludedPackIds,
      selectedPackIds
    },
    starter: structuredClone(starter),
    packs: selectedPackIds.map((id) => structuredClone(catalog.byId.get(id))),
    customCapabilities: normalizedCustomCapabilities,
    machineCapabilities: {
      semantics: "internal-planning-and-review-only",
      knownCapabilityIds,
      ownerDefinedCapabilityIds,
      allCapabilityIds,
      publicDiscoveryTagInference: "forbidden"
    },
    tagSuggestions: {
      semantics: "owner-provided-local-discovery-only",
      catalogMembershipRequired: false,
      ownerProvidedLocalTags: normalizedLocalTags,
      machineCapabilityInference: "forbidden",
      providerSupportInference: "forbidden"
    }
  };
}

export function materializeTemplate({
  catalog,
  starterId,
  packIds = [],
  customCapabilities = [],
  localTags = [],
  targetDirectory
}) {
  const plan = composeTemplate({ catalog, starterId, packIds, customCapabilities, localTags });
  const target = validateNewTarget(targetDirectory);
  const files = renderTemplateFiles(plan);
  const parent = path.dirname(target);
  const temporary = fs.mkdtempSync(path.join(parent, ".programmable-template-"));
  fs.chmodSync(temporary, 0o700);

  let renamed = false;
  try {
    for (const [relativePath, contents] of files) {
      const outputPath = path.join(temporary, relativePath);
      fs.writeFileSync(outputPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    fs.renameSync(temporary, target);
    renamed = true;
  } finally {
    if (!renamed && fs.existsSync(temporary)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  return {
    schemaVersion: "1.0.0",
    kind: "template-materialization",
    targetDirectory: target,
    catalogDigest: plan.catalogDigest,
    selectionDigest: plan.selectionDigest,
    starterId: plan.selection.starterId,
    selectedPackIds: plan.selection.selectedPackIds,
    customCapabilityIds: plan.customCapabilities.map(({ id }) => id),
    localTags: plan.tagSuggestions.ownerProvidedLocalTags,
    files: files.map(([relativePath, contents]) => ({
      path: relativePath,
      bytes: Buffer.byteLength(contents, "utf8"),
      sha256: sha256(Buffer.from(contents, "utf8"))
    }))
  };
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("CANONICAL_JSON_INVALID", "Canonical JSON accepts safe integers only.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) fail("CANONICAL_JSON_INVALID", "Canonical JSON accepts plain objects only.");
  return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function validateManifest(manifest) {
  assertExactKeys(manifest, catalogKeys, "catalog");
  if (manifest.schemaVersion !== "1.0.0" || manifest.kind !== "programmable-starter-catalog") {
    fail("CATALOG_SCHEMA_INVALID", "Catalog schemaVersion or kind is unsupported.");
  }
  assertExactKeys(manifest.policy, policyKeys, "catalog.policy");
  if (
    manifest.policy.selectionSemantics !== "accelerator-only"
    || manifest.policy.unknownCapabilityOutcome !== "architecture-review-required"
    || manifest.policy.missingCatalogLabelOutcome !== "preserve-custom-capability"
    || manifest.policy.automaticAdverseDecision !== false
  ) {
    fail("CATALOG_POLICY_INVALID", "Catalog policy must preserve novelty and have no automatic adverse decision.");
  }
  assertIdArray(manifest.mandatoryPacks, "catalog.mandatoryPacks", { maximum: 16 });
  if (!manifest.mandatoryPacks.includes("programmable-volume-fee")) {
    fail("CATALOG_POLICY_INVALID", "The mandatory Programmable volume-fee pack is missing.");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length < 1 || manifest.entries.length > 64) {
    fail("CATALOG_SCHEMA_INVALID", "Catalog entries must contain 1 through 64 definitions.");
  }
  const ids = [];
  const paths = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    assertExactKeys(entry, entryKeys, `catalog.entries[${index}]`);
    assertId(entry.id, `catalog.entries[${index}].id`);
    if (entry.kind !== "starter" && entry.kind !== "pack") {
      fail("CATALOG_SCHEMA_INVALID", `catalog.entries[${index}].kind must be starter or pack.`);
    }
    const expectedPrefix = entry.kind === "starter" ? "starters/" : "packs/";
    if (entry.path !== `${expectedPrefix}${entry.id}.json`) {
      fail("CATALOG_PATH_INVALID", `Catalog entry ${entry.id} has a noncanonical path.`);
    }
    assertRelativePath(entry.path, `catalog.entries[${index}].path`);
    if (!sha256Pattern.test(entry.sha256)) {
      fail("CATALOG_SCHEMA_INVALID", `catalog.entries[${index}].sha256 must be lowercase SHA-256.`);
    }
    if (paths.has(entry.path)) fail("CATALOG_SCHEMA_INVALID", `Duplicate catalog path: ${entry.path}.`);
    paths.add(entry.path);
    ids.push(entry.id);
  }
  assertSortedUnique(ids, "catalog entry ids");
}

function validateDefinition(definition, entry) {
  assertExactKeys(definition, entry.kind === "starter" ? starterKeys : packKeys, `definition ${entry.id}`);
  if (definition.schemaVersion !== "1.0.0" || definition.kind !== entry.kind || definition.id !== entry.id) {
    fail("CATALOG_DEFINITION_INVALID", `Definition identity mismatch for ${entry.id}.`);
  }
  assertSafeText(definition.label, `${entry.id}.label`, { maximumBytes: 120 });
  assertSafeText(definition.summary, `${entry.id}.summary`, { maximumBytes: 360 });
  if (
    definition.acceleratorOnly !== true
    || definition.eligibilityEffect !== "none"
    || definition.unknownCapabilityPolicy !== "preserve-and-route"
  ) {
    fail("CATALOG_POLICY_INVALID", `Definition ${entry.id} must be an accelerator with no eligibility effect.`);
  }
  if (!reviewRoutes.has(definition.reviewRoute)) {
    fail("CATALOG_DEFINITION_INVALID", `Definition ${entry.id} has an unknown review route.`);
  }
  const dependencyField = definition.kind === "starter" ? "defaultPacks" : "requires";
  assertIdArray(definition[dependencyField], `${entry.id}.${dependencyField}`, { maximum: 16, allowEmpty: true });
  assertIdArray(definition.conflictsWith, `${entry.id}.conflictsWith`, { maximum: 16, allowEmpty: true });
  assertIdArray(definition.capabilities, `${entry.id}.capabilities`, { maximum: 32 });
  assertIdArray(definition.projectSurfaces, `${entry.id}.projectSurfaces`, { maximum: 16 });
  assertTextArray(definition.requiredFacts, `${entry.id}.requiredFacts`, { maximum: 32 });
  assertTextArray(definition.requiredFiles, `${entry.id}.requiredFiles`, { maximum: 32 });
  assertTextArray(definition.requiredTests, `${entry.id}.requiredTests`, { maximum: 32 });
  assertTextArray(definition.risks, `${entry.id}.risks`, { maximum: 32 });
  if (definition.conflictsWith.includes(definition.id)) {
    fail("CATALOG_DEFINITION_INVALID", `Definition ${entry.id} conflicts with itself.`);
  }
}

function validateCrossReferences(manifest, byId) {
  for (const mandatoryPack of manifest.mandatoryPacks) {
    if (byId.get(mandatoryPack)?.kind !== "pack") {
      fail("CATALOG_REFERENCE_INVALID", `Mandatory pack ${mandatoryPack} is not a packaged capability pack.`);
    }
  }
  for (const definition of byId.values()) {
    const requirements = definition.kind === "starter" ? definition.defaultPacks : definition.requires;
    for (const requiredId of requirements) {
      if (byId.get(requiredId)?.kind !== "pack") {
        fail("CATALOG_REFERENCE_INVALID", `${definition.id} requires unknown pack ${requiredId}.`);
      }
    }
    for (const conflictId of definition.conflictsWith) {
      if (!byId.has(conflictId)) {
        fail("CATALOG_REFERENCE_INVALID", `${definition.id} conflicts with unknown entry ${conflictId}.`);
      }
    }
    if (definition.kind === "starter") {
      for (const mandatoryPack of manifest.mandatoryPacks) {
        if (!definition.defaultPacks.includes(mandatoryPack)) {
          fail("CATALOG_POLICY_INVALID", `Starter ${definition.id} omits mandatory pack ${mandatoryPack}.`);
        }
      }
    }
  }
  for (const definition of byId.values()) {
    if (definition.kind === "pack") assertNoRequirementCycle(definition.id, byId, []);
  }
}

function assertNoRequirementCycle(id, byId, stack) {
  if (stack.includes(id)) {
    fail("CATALOG_REQUIREMENT_CYCLE", `Capability-pack requirement cycle: ${[...stack, id].join(" -> ")}.`);
  }
  for (const requiredId of byId.get(id).requires) {
    assertNoRequirementCycle(requiredId, byId, [...stack, id]);
  }
}

function normalizeRequestedIds(values, label) {
  if (!Array.isArray(values)) fail("TEMPLATE_SELECTION_INVALID", `${label} values must be an array.`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    assertId(value, label);
    if (seen.has(value)) fail("TEMPLATE_SELECTION_INVALID", `Duplicate ${label}: ${value}.`);
    seen.add(value);
    result.push(value);
  }
  return result.sort(compareUtf8);
}

function normalizeCustomCapabilities(values) {
  if (!Array.isArray(values)) {
    fail("CUSTOM_CAPABILITY_INVALID", "Custom capabilities must be an array.");
  }
  const result = values.map((value) => {
    const normalized = typeof value === "string" ? parseCustomCapability(value) : value;
    assertExactKeys(normalized, ["id", "label"], "custom capability");
    assertId(normalized.id, "custom capability id");
    assertSafeText(normalized.label, "custom capability label", { maximumBytes: 120 });
    return {
      id: normalized.id,
      label: normalized.label,
      catalogStatus: "unlisted",
      automaticDecision: "none",
      reviewRoute: "architecture-review-required",
      eligibilityEffect: "none",
      requiredFacts: [
        "Actors and assets",
        "Authority and trust boundary",
        "Value flow and conservation",
        "Failure, recovery and user exit",
        "Source, tests and attributable evidence"
      ]
    };
  });
  result.sort((left, right) => compareUtf8(left.id, right.id));
  assertSortedUnique(result.map(({ id }) => id), "custom capability ids");
  return result;
}

function normalizeLocalTags(values) {
  if (!Array.isArray(values) || values.length > 64) {
    fail("LOCAL_TAG_INVALID", "Local tags must be an array with at most 64 values.");
  }
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const tag = parseLocalTag(value);
    if (seen.has(tag)) fail("LOCAL_TAG_INVALID", `Duplicate local tag: ${tag}.`);
    seen.add(tag);
    result.push(tag);
  }
  return result.sort(compareUtf8);
}

function renderTemplateFiles(plan) {
  const files = [
    ["CAPABILITY_CHECKLIST.md", renderCapabilityChecklist(plan)],
    ["EVIDENCE.md", renderEvidence(plan)],
    ["METADATA_AND_DISCLOSURES.md", renderMetadata(plan)],
    ["PROPOSAL.md", renderProposal(plan)],
    ["TAGS.md", renderTags(plan)],
    ["TEST_PLAN.md", renderTestPlan(plan)],
    ["THREAT_MODEL.md", renderThreatModel(plan)],
    ["programmable-template.json", `${JSON.stringify(plan, null, 2)}\n`]
  ];
  files.sort(([left], [right]) => compareUtf8(left, right));
  return files;
}

function renderProposal(plan) {
  const definitions = [plan.starter, ...plan.packs];
  return lines([
    "# Project proposal",
    "",
    "> This starter is an accelerator, not an allowlist, approval, audit, deployment receipt or provider promise.",
    "",
    "## Outcome",
    "",
    "Describe what the user can do and what a complete successful lifecycle looks like.",
    "",
    "## Selected foundation",
    "",
    `- Starter: ${md(plan.starter.label)} (\`${plan.starter.id}\`)`,
    ...plan.packs.map((pack) => `- Capability pack: ${md(pack.label)} (\`${pack.id}\`)`),
    ...plan.customCapabilities.map((capability) => `- Owner-defined capability: ${md(capability.label)} (\`${capability.id}\`), routed to architecture review`),
    "",
    "## Architecture-changing facts",
    "",
    ...checklist(unique(definitions.flatMap((definition) => definition.requiredFacts))),
    ...customFactSections(plan.customCapabilities),
    "",
    "## Lifecycle",
    "",
    "Describe creation, configuration, normal use, claims, exits, failures, recovery, upgrades if any, and retirement.",
    "",
    "## Value and authority",
    "",
    "List every asset movement and every actor that can change behavior, move value, pause a path, replace a dependency or affect a user exit.",
    "",
    "## Open decisions",
    "",
    "Keep unresolved facts explicit. A missing catalog label is not a rejection; preserve the capability and request architecture review.",
    ""
  ]);
}

function renderCapabilityChecklist(plan) {
  const definitions = [plan.starter, ...plan.packs];
  return lines([
    "# Capability checklist",
    "",
    `Catalog digest: \`${plan.catalogDigest}\``,
    `Selection digest: \`${plan.selectionDigest}\``,
    "",
    "## Known accelerators",
    "",
    ...definitions.flatMap((definition) => [
      `### ${md(definition.label)}`,
      "",
      md(definition.summary),
      "",
      `Review route: \`${definition.reviewRoute}\``,
      "",
      ...checklist(definition.capabilities.map((capability) => `Capability: ${capability}`)),
      ""
    ]),
    "## Owner-defined capabilities",
    "",
    ...(plan.customCapabilities.length === 0
      ? ["No owner-defined capability has been added yet."]
      : plan.customCapabilities.flatMap((capability) => [
          `### ${md(capability.label)} (\`${capability.id}\`)`,
          "",
          "Catalog status: `unlisted`. Automatic decision: `none`. Route: `architecture-review-required`.",
          "",
          ...checklist(capability.requiredFacts),
          ""
        ])),
    "",
    "An unlisted capability remains part of the project. It is never unsafe or rejected solely because this catalog lacks a label.",
    ""
  ]);
}

function renderThreatModel(plan) {
  const definitions = [plan.starter, ...plan.packs];
  return lines([
    "# Threat model",
    "",
    "## Assets, actors and trust boundaries",
    "",
    "List assets at risk, trusted and untrusted actors, external systems, privilege boundaries and maximum losses.",
    "",
    "## Capability-specific risks",
    "",
    ...definitions.flatMap((definition) => [
      `### ${md(definition.label)}`,
      "",
      ...checklist(definition.risks),
      ""
    ]),
    ...plan.customCapabilities.flatMap((capability) => [
      `### ${md(capability.label)} (owner-defined)`,
      "",
      "- [ ] Identify attacker goals, authority abuse, value-loss bounds, dependency failures and user-exit failures.",
      ""
    ]),
    "## Security properties",
    "",
    "Write falsifiable safety, solvency, conservation, authorization, liveness and exit properties. Template text is not evidence.",
    ""
  ]);
}

function renderTestPlan(plan) {
  const definitions = [plan.starter, ...plan.packs];
  return lines([
    "# Test plan",
    "",
    "> Record exact commands, tool versions, fixture identities, seeds, passes, failures and skips. A skipped test is not passing evidence.",
    "",
    "## Required scenarios",
    "",
    ...definitions.flatMap((definition) => [
      `### ${md(definition.label)}`,
      "",
      ...checklist(definition.requiredTests),
      ""
    ]),
    ...plan.customCapabilities.flatMap((capability) => [
      `### ${md(capability.label)} (owner-defined)`,
      "",
      "- [ ] Add capability-specific unit, integration, adversarial and property tests after architecture review.",
      ""
    ]),
    "## Reproducibility",
    "",
    "- [ ] Build and test from a clean pinned environment without secrets.",
    "- [ ] Bind every executed check to the exact source revision and dependency closure.",
    "- [ ] Keep local, independent-review, deployment, provider and live evidence separate.",
    ""
  ]);
}

function renderEvidence(plan) {
  const definitions = [plan.starter, ...plan.packs];
  return lines([
    "# Evidence index",
    "",
    "## Required project artifacts",
    "",
    ...checklist(unique(definitions.flatMap((definition) => definition.requiredFiles))),
    "",
    "## Results",
    "",
    "For every result record the source revision, command, environment, output hash, pass or fail state, skips and owner of the evidence.",
    "",
    "| Evidence state | Result | Exact artifact or blocker |",
    "| --- | --- | --- |",
    "| Local build and tests | Not run | |",
    "| Independent review | Not started | |",
    "| Deployment | Not started | |",
    "| Source verification | Not started | |",
    "| Lifecycle verification | Not started | |",
    "| Provider indexing and routing | Unknown per provider | |",
    "| Public availability | Not started | |",
    ""
  ]);
}

function renderMetadata(plan) {
  return lines([
    "# Metadata and disclosures",
    "",
    "## Canonical public identity",
    "",
    "- [ ] Project name and token name",
    "- [ ] Token symbol",
    "- [ ] Plain-language description",
    "- [ ] Canonical project, metadata and media URIs",
    "- [ ] Exact logo and media byte hashes",
    "- [ ] Metadata owner, mutability and change history",
    "",
    "## Economics and controls",
    "",
    "- [ ] LP fee, mandatory Programmable share, project hook-owned share and transfer tax shown separately",
    "- [ ] Mint, pause, blacklist, confiscation, upgrade, rescue and payout-redirection powers disclosed",
    "- [ ] External services, assets, signers, keepers and oracles disclosed",
    "- [ ] Affiliations and non-affiliations stated without implying endorsement",
    "",
    "## Provider evidence",
    "",
    "Track GMGN, Fomo, Dexscreener, Uniswap, wallets, routers and other providers separately. Use `unknown`, `unsupported`, `stale` or evidence-backed support; never convert a desired tag into a provider claim.",
    "",
    "## Text and media safety",
    "",
    "Use visible NFC text without bidirectional, zero-width, control or deceptive confusable characters. Bind raster media bytes and reject active content on canonical metadata origins.",
    "",
    `Template selection: \`${plan.selectionDigest}\``,
    ""
  ]);
}

function renderTags(plan) {
  return lines([
    "# Tags",
    "",
    "## Owner-provided local project tags",
    "",
    "Only owner-provided visible slug-safe labels appear here. Internal starter, pack, security and machine-capability ids are never converted into public tags automatically. These tags describe the selected local project only and do not claim listing, routing, indexing or endorsement by any external provider.",
    "",
    ...(plan.tagSuggestions.ownerProvidedLocalTags.length === 0
      ? ["No owner-provided local discovery tags were selected."]
      : plan.tagSuggestions.ownerProvidedLocalTags.map((tag) => `- \`${tag}\``)),
    "",
    "## Provider-specific tags and claims",
    "",
    "Keep requested provider labels separate from local tags. Every provider begins as `unknown`; change it only from current attributable external evidence.",
    "",
    "| Provider | Requested provider tag | Evidence state | Current attributable evidence |",
    "| --- | --- | --- | --- |",
    "| GMGN | | unknown | |",
    "| Fomo | | unknown | |",
    "| Dexscreener | | unknown | |",
    "| Uniswap routing or interface | | unknown | |",
    "| Wallets and other terminals | | unknown | |",
    "",
    "Never turn a desired label or successful local test into a provider-support claim.",
    ""
  ]);
}

function customFactSections(capabilities) {
  return capabilities.flatMap((capability) => [
    "",
    `### ${md(capability.label)} (owner-defined)`,
    "",
    ...checklist(capability.requiredFacts)
  ]);
}

function checklist(values) {
  return values.map((value) => `- [ ] ${md(value)}`);
}

function unique(values) {
  return [...new Set(values)];
}

function md(value) {
  return String(value).replace(/([\\`*_{}\[\]<>#+!|])/gu, "\\$1");
}

function lines(values) {
  return `${values.join("\n")}\n`;
}

function validateNewTarget(targetDirectory) {
  if (typeof targetDirectory !== "string" || targetDirectory.length === 0 || targetDirectory.includes("\0")) {
    fail("TARGET_INVALID", "Target directory must be a nonempty local path.");
  }
  const target = path.resolve(targetDirectory);
  const parent = path.dirname(target);
  if (target === parent || [".", "..", ""].includes(path.basename(target))) {
    fail("TARGET_INVALID", "Target directory must name one new child directory.");
  }
  assertSafeText(path.basename(target), "target directory name", { maximumBytes: 200 });
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (targetStat) {
    fail("TARGET_EXISTS", "Target directory must not already exist, even when it is empty.", { target });
  }
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (error) {
    if (error?.code === "ENOENT") fail("TARGET_PARENT_MISSING", "Target parent directory must already exist.", { parent });
    throw error;
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail("TARGET_PARENT_INVALID", "Target parent must be a real local directory, not a symbolic link.", { parent });
  }
  return target;
}

function readJsonFile(filePath, maximumBytes) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail("CATALOG_FILE_MISSING", `Missing catalog file: ${filePath}.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) {
    fail("CATALOG_FILE_INVALID", `Catalog file is not a bounded regular file: ${filePath}.`);
  }
  const bytes = fs.readFileSync(filePath);
  let text;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    fail("CATALOG_JSON_INVALID", `Catalog file is not valid UTF-8: ${filePath}.`);
  }
  if (text.startsWith("\ufeff")) fail("CATALOG_JSON_INVALID", `Catalog file has a forbidden byte-order mark: ${filePath}.`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("CATALOG_JSON_INVALID", `Catalog file is not valid JSON: ${filePath}.`);
  }
  return { value, bytes };
}

function assertNoUnlistedDefinitions(directory, entries) {
  const expected = entries.map(({ path: relativePath }) => relativePath).sort(compareUtf8);
  const actual = ["packs", "starters"].flatMap((subdirectory) => {
    const absolute = path.join(directory, subdirectory);
    assertDirectory(absolute, `${subdirectory} directory`);
    return fs.readdirSync(absolute, { withFileTypes: true }).map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        fail("CATALOG_FILE_INVALID", `Unexpected catalog entry: ${subdirectory}/${entry.name}.`);
      }
      return `${subdirectory}/${entry.name}`;
    });
  }).sort(compareUtf8);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("CATALOG_MANIFEST_INCOMPLETE", "Catalog manifest and packaged definition files differ.", { expected, actual });
  }
}

function resolveCatalogPath(directory, relativePath) {
  assertRelativePath(relativePath, "catalog entry path");
  const resolved = path.resolve(directory, relativePath);
  if (!resolved.startsWith(`${directory}${path.sep}`)) {
    fail("CATALOG_PATH_INVALID", `Catalog path escapes its directory: ${relativePath}.`);
  }
  return resolved;
}

function assertDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") fail("CATALOG_FILE_MISSING", `Missing ${label}: ${directory}.`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("CATALOG_FILE_INVALID", `${label} must be a real directory: ${directory}.`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail("CATALOG_SCHEMA_INVALID", `${label} must be an object.`);
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...expectedKeys].sort(compareUtf8);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("CATALOG_SCHEMA_INVALID", `${label} has missing or unknown fields.`, { expected, actual });
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 80 || !idPattern.test(value)) {
    fail("CATALOG_ID_INVALID", `${label} must use lowercase letters, digits and single hyphens.`);
  }
}

function assertLocalTag(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 80 || !idPattern.test(value)) {
    fail(
      "LOCAL_TAG_INVALID",
      `${label} must be a safe lowercase slug using letters, digits and single hyphens; catalog membership is never required.`
    );
  }
}

function assertIdArray(value, label, { maximum, allowEmpty = false }) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) {
    fail("CATALOG_SCHEMA_INVALID", `${label} has an invalid number of ids.`);
  }
  for (const id of value) assertId(id, label);
  assertSortedUnique(value, label);
}

function assertTextArray(value, label, { maximum }) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    fail("CATALOG_SCHEMA_INVALID", `${label} has an invalid number of text entries.`);
  }
  const seen = new Set();
  for (const text of value) {
    assertSafeText(text, label, { maximumBytes: 600 });
    if (seen.has(text)) fail("CATALOG_SCHEMA_INVALID", `${label} contains duplicate text.`);
    seen.add(text);
  }
}

function assertSortedUnique(values, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(values[index - 1], values[index]) >= 0) {
      fail("CATALOG_ORDER_INVALID", `${label} must be unique and sorted by UTF-8 bytes.`);
    }
  }
}

function assertSafeText(value, label, { maximumBytes }) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || value !== value.normalize("NFC")
    || value.trim() !== value
    || unsafeUnicodePattern.test(value)
  ) {
    fail("CATALOG_TEXT_INVALID", `${label} must be bounded visible NFC text without control or bidirectional characters.`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
      || (codePoint >= 0xe000 && codePoint <= 0xf8ff)
      || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
      || (codePoint >= 0x100000 && codePoint <= 0x10fffd)
      || (codePoint & 0xffff) === 0xfffe
      || (codePoint & 0xffff) === 0xffff
    ) {
      fail("CATALOG_TEXT_INVALID", `${label} contains a private-use, surrogate or noncharacter code point.`);
    }
  }
}

function assertRelativePath(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > 240
    || value.startsWith("/")
    || value.includes("\\")
    || value !== value.normalize("NFC")
    || unsafeUnicodePattern.test(value)
  ) {
    fail("CATALOG_PATH_INVALID", `${label} is not a safe relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("CATALOG_PATH_INVALID", `${label} contains an empty or traversal segment.`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function domainHash(domain, payload) {
  return crypto.createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(payload, "utf8"))
    .digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code, message, details = undefined) {
  throw new TemplateCatalogError(code, message, details);
}
