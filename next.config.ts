import type { NextConfig } from "next";
import { glob } from 'glob';

module.exports = {
  transpilePackages: [
    '@adobe/react-spectrum',
    '@react-spectrum/*',
    '@spectrum-icons/*'
  ].flatMap((spec) => glob.sync(`${spec}`, { cwd: 'node_modules/' }))
};

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
};

export default nextConfig;
