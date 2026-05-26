import app from "./app";
import { logger } from "./lib/logger";
import { seedDefaults } from "./lib/seed-defaults";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Idempotent seed-on-boot: ensures settings rows and (if price_list is empty)
// the default price list exist. Logged as a warning if it fails so the server
// still starts — the only required runtime data is the orders table.
seedDefaults().catch((err) => {
  logger.warn({ err }, "seedDefaults failed at boot");
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
