const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const contractsSource = path.resolve(__dirname, "../../packages/contracts/src") + path.sep;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (context.originModulePath.startsWith(contractsSource) && moduleName.startsWith("./") && moduleName.endsWith(".js")) {
    return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
