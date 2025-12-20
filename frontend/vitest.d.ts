import { DownloadedTextFile } from "__tests__/command-download";

declare module "vitest/browser" {
  interface BrowserCommands {
    listenForFileDownload: () => Promise<DownloadedTextFile>
  }
}
