let verbose = false;

export function setVerbose(enabled: boolean) {
  verbose = enabled;
}

export function logVerbose(content: string) {
  if (verbose) {
    console.log(`verbose: ${content}`);
  }
}

export interface NpmConfig {
  name: string;
  value: string;
  position: {
    line: number;
  };
}
