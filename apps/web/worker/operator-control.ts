import { DurableObject } from "cloudflare:workers";

import { CollectorCatalogClient } from "../../../packages/integrations/src/collector-catalog.js";
import { createAccessAuthenticator } from "../../operator/src/operator-access-auth.js";
import { OperatorCatalogService } from "../../operator/src/operator-catalog-service.js";
import { createBindingOperatorControlHandler } from "../../operator/src/operator-control-api.js";
import { loadOperatorBindingConfiguration } from "../../operator/src/operator-control-config.js";
import { DurableOperatorControlStore } from "../../operator/src/operator-control-durable-store.js";

export class OperatorControlDurableObject extends DurableObject<Env> {
  readonly #handleRequest: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const configuration = loadOperatorBindingConfiguration({ env });
    const store = new DurableOperatorControlStore({ storage: ctx.storage });
    store.initialize();
    const collectorOptions = {
      ...configuration.collector,
      fetchImpl: fetch,
    };
    const catalogServiceOptions = {
      client: new CollectorCatalogClient(collectorOptions),
      store,
      now: Date.now,
    };
    const catalogService = new OperatorCatalogService(catalogServiceOptions);
    const authenticatorOptions = {
      issuer: configuration.issuer,
      audience: configuration.audience,
      operatorSubjects: configuration.operatorSubjects,
      jwtVerifyImpl: undefined,
    };
    const authenticator = createAccessAuthenticator(authenticatorOptions);
    this.#handleRequest = createBindingOperatorControlHandler({
      allowedOrigin: configuration.allowedOrigin,
      hardCaps: configuration.hardCaps,
      authenticator,
      store,
      catalogService,
    });
  }

  handleOperatorRequest(request: Request): Promise<Response> {
    return this.#handleRequest(request);
  }
}
