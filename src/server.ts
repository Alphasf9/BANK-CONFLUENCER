import { createApp } from "./app";
import { config } from "./config";
import { openDb } from "./db";

const db = openDb(config.databasePath);
const app = createApp(db);

const server = app.listen(config.port, () => {
  console.log(`Ledger API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.databasePath}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
