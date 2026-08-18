import { BrowserCommand } from "vitest/node";

export interface DownloadedTextFile {
  suggestedFilename: string
  url: string
  content: string
}

export const listenForFileDownload: BrowserCommand<[], DownloadedTextFile> =
  async ctx => {
    const download = await ctx.page.waitForEvent("download");
    const stream = await download.createReadStream();
    stream.setEncoding("utf-8");

    const content = await stream.toArray();

    return {
      suggestedFilename: download.suggestedFilename(),
      url: download.url(),
      content: content.join()
    };
  };
