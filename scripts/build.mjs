import { spawnSync } from "node:child_process";

const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
};

run(process.execPath, ["node_modules/typescript/bin/tsc"]);
run(process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
