import type { NextConfig } from "next";
import { glob } from 'glob';

module.exports = {
};

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  transpilePackages: [
    '@adobe/react-spectrum',
    '@react-spectrum/*',
    '@spectrum-icons/*'
  ].flatMap((spec) => glob.sync(`${spec}`, { cwd: 'node_modules/' })),
  output: "standalone"
};

module.exports = nextConfig

export default nextConfig;
