import { createApp } from "./app";
import { config } from "./config";
const app = createApp();

app.listen({ hostname: config.host, port: config.port });

console.log(`[babel-review-backend] listening on ${config.publicBaseUrl} (bind ${config.host}:${config.port})`);
console.log(
  `[babel-review-backend] cors origin: ${
    config.corsOrigin === true ? "*" : config.corsOrigin.join(", ")
  }`
);
console.log(`[babel-review-backend] model: ${config.openRouterModel}`);
console.log(`[babel-review-backend] test mode: ${config.openRouterTestMode}`);

export type App = typeof app;
