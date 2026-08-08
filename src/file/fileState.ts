export type LoadedFile = {
  path: string;
  name: string;
  content: string;
  modifiedMs: number;
};

export type PreflightFindings = {
  rawHtml: number;
  unsafeUri: number;
  remoteImages: number;
  largeDataUri: number;
  longLines: number;
  excessiveLinks: number;
  excessiveImages: number;
};

export type PreflightFile = {
  path: string;
  name: string;
  modifiedMs: number;
  token: string;
  findings: PreflightFindings;
};
