export function namespaceFor<Host>(host: Host) {
  const names: string[] = [];

  return {
    names,
    getByName(name: string): Host {
      names.push(name);

      return host;
    },
  };
}
