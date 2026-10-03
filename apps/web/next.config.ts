import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@parlance/contracts"],
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = { ...webpackConfig.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return webpackConfig;
  },
};
export default config;
