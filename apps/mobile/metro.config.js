const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const fs = require("node:fs");

const config = getDefaultConfig(__dirname);
// pnpm may place package contents outside the workspace. Keep Metro's module
// search rooted at this app so release bundling resolves peer dependencies.
const expoPackage = fs.realpathSync(path.dirname(require.resolve("expo/package.json")));
const workspaceRoot = path.resolve(__dirname, "../..");
if (!expoPackage.startsWith(`${workspaceRoot}${path.sep}`)) {
  const virtualStore = path.dirname(path.dirname(path.dirname(expoPackage)));
  config.watchFolders = [...(config.watchFolders ?? []), virtualStore];
}
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules"), path.resolve(__dirname, "../../node_modules")];
const contractsSource = path.resolve(__dirname, "../../packages/contracts/src") + path.sep;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (context.originModulePath.startsWith(contractsSource) && moduleName.startsWith("./") && moduleName.endsWith(".js")) {
    return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
