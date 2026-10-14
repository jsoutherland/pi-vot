export interface BrowserOpenCommand {
  command: string;
  args: string[];
}

export interface BrowserOpenOptions {
  platform?: NodeJS.Platform | string;
  spawnProcess?: (command: string, args: string[], options: Record<string, unknown>) => {
    once(event: "error", listener: (error: Error) => void): unknown;
    unref(): void;
  };
  onError?: (error: Error) => void;
}

export declare function browserOpenCommand(platform: string, url: string): BrowserOpenCommand | null;
export declare function openDefaultBrowser(url: string, options?: BrowserOpenOptions): boolean;
