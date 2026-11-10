export type FuzzState = {
  mode: string;
  audit: string[];
  auditing: boolean;
  patched: boolean;
};

export const fz: FuzzState = { mode: "none", audit: [], auditing: false, patched: false };
