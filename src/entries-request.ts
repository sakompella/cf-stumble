export type EntriesRequest = Readonly<{
  minEntryId: number | undefined;
  maxEntryId: number | undefined;
  order: "ascending" | "descending";
  limit: number;
}>;
