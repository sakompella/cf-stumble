import {
  DIRS,
  HISTORY,
  LINES,
  MESSAGES,
  NAMES,
  READS,
  path,
  quote,
  random,
  type Backend,
  type Case,
  type Random,
} from "./git-data.mts";

type World = {
  files: string[];
  branches: string[];
  commits: number;
  pushed: string[];
  pushes: number;
  made: number;
};

function setup(command: string, oracle: string = command): Case {
  return { kind: "setup", backend: "isolate", command, oracle };
}

export class Generator {
  readonly #random: Random;
  readonly #runId: string;
  readonly #world: World = { files: [], branches: [], commits: 0, pushed: [], pushes: 0, made: 0 };

  constructor(seed: number, runId: string) {
    this.#random = random(seed);
    this.#runId = runId;
  }

  pushedBranches(): readonly string[] {
    return this.#world.pushed;
  }

  setup(): readonly Case[] {
    const seeded = this.#random.chance(0.75);

    if (seeded) this.#world.files.push("a.txt", "src/x.ts", "docs/readme.md");

    const seed: readonly Case[] = seeded
      ? [
          setup(
            "mkdir -p src docs && printf 'alpha\\n' > a.txt && printf 'beta\\n' > src/x.ts && printf 'gamma\\n' > docs/readme.md",
          ),
          setup("git add -A"),
          setup("git commit -q -m init"),
        ]
      : [];

    return [
      setup("git init", "git init && git config core.fileMode false"),
      setup("git config user.name fuzz"),
      setup("git config user.email fuzz@example.invalid"),
      setup(
        "git remote add origin https://github.com/sakompella/cf-stumble.git",
        "git remote add origin $ORIGIN",
      ),
      ...seed,
    ];
  }

  next(blocked: (item: Case) => boolean = () => false): Case {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const item = this.#draw();

      if (!blocked(item)) return item;
    }

    return this.#draw();
  }

  #draw(): Case {
    const r = this.#random;
    const roll = r.int(100);

    if (roll < 30) return this.#files();

    if (roll < 62) return this.#index();

    if (roll < 74) return this.#commit();

    if (roll < 82) return this.#branches();

    if (roll < 90) return this.#reads();

    if (roll < 96) return this.#history();

    return this.#remote();
  }

  #name(): string {
    const { files } = this.#world;

    return this.#random.chance(0.8) && files.length > 0
      ? this.#random.pick(files)
      : this.#random.pick(NAMES);
  }

  #made(name: string): void {
    if (!this.#world.files.includes(name)) this.#world.files.push(name);
  }

  #files(): Case {
    const r = this.#random;
    const backend: Backend = r.chance(0.55) ? "isolate" : "container";
    const command = r.chance(0.65) ? this.#write(r.pick(NAMES)) : this.#change();

    return { kind: "fs", backend, command };
  }

  #write(name: string): string {
    const r = this.#random;
    const target = quote(path(name));
    const slash = name.lastIndexOf("/");
    const parent = slash === -1 ? "" : `mkdir -p ${quote(name.slice(0, slash))} && `;
    const lines = Array.from({ length: 1 + r.int(4) }, () => r.pick(LINES));

    const body = r.pick([
      `printf ${quote(`${lines.join("\\n")}\\n`)} > ${target}`,
      `printf ${quote(lines.join("\\r\\n"))} > ${target}`,
      `printf 'x\\n' >> ${target}`,
      `: > ${target}`,
      `seq 1 ${100 + r.int(2000)} > ${target}`,
      `cp ${quote(path(this.#name()))} ${target}`,
    ]);

    this.#made(name);

    return `${parent}${body}`;
  }

  #change(): string {
    const r = this.#random;
    const from = quote(path(this.#name()));
    const to = r.pick(NAMES);
    const slash = to.lastIndexOf("/");
    const mode = r.pick(["+x", "-x", "755", "644"]);
    const edit = quote(`s/${r.pick(LINES)}/${r.pick(LINES)}/`);
    const move = `mkdir -p ${quote(slash === -1 ? "." : to.slice(0, slash))} && mv -f ${from} ${quote(path(to))}`;
    const kind = r.int(4);

    if (kind === 2) this.#made(to);

    return (
      [`rm -rf ${from}`, `chmod ${mode} ${from}`, move, `sed -i ${edit} ${from}`][kind] ?? "true"
    );
  }

  #pathspec(): string {
    const r = this.#random;

    const forms = [
      () => quote(path(this.#name())),
      () => ".",
      () => quote(r.pick(DIRS)),
      () => `${quote(path(this.#name()))} ${quote(path(this.#name()))}`,
      () => `-- ${quote(path(this.#name()))}`,
      () => quote("*.txt"),
      () => quote(`${r.pick(DIRS)}/`),
    ];

    return r.pick(forms)();
  }

  #git(kind: string, command: string, writes = true): Case {
    const container = this.#random.chance(writes ? 0.35 : 0.5);

    return { kind, backend: container ? "container" : "isolate", command: `git ${command}` };
  }

  #index(): Case {
    const r = this.#random;
    const pathspec = this.#pathspec();

    return r.pick<() => Case>([
      () => this.#git("add", `add ${pathspec}`),
      () => this.#git("add", "add ."),
      () => this.#git("add", "add -A"),
      () => this.#git("add", "add -u"),
      () => this.#git("add", `add -u ${pathspec}`),
      () => this.#git("add", `add -f ${pathspec}`),
      () => this.#git("rm", `rm ${pathspec}`),
      () => this.#git("rm", `rm --cached ${pathspec}`),
      () => this.#git("rm", `rm -r ${pathspec}`),
      () => this.#git("rm", `rm -rf ${pathspec}`),
      () => this.#git("mv", `mv ${quote(path(this.#name()))} ${quote(path(this.#name()))}`),
      () => this.#git("mv", `mv ${quote(path(this.#name()))} ${quote(r.pick(DIRS))}/`),
      () => this.#git("restore", `restore ${pathspec}`),
      () => this.#git("restore", `restore --staged ${pathspec}`),
      () => this.#git("restore", `restore --source=HEAD ${pathspec}`),
      () => this.#git("restore", `restore -s HEAD --staged --worktree ${pathspec}`),
      () => this.#git("checkout--", `checkout -- ${quote(path(this.#name()))}`),
      () => this.#git("checkout--", `checkout HEAD -- ${quote(path(this.#name()))}`),
      () => this.#git("reset", "reset"),
      () => this.#git("reset", `reset -- ${quote(path(this.#name()))}`),
      () => this.#git("reset", `reset ${quote(path(this.#name()))}`),
      () => this.#git("reset", `reset HEAD ${quote(path(this.#name()))}`),
    ])();
  }

  #commit(): Case {
    const r = this.#random;
    const message = quote(r.pick(MESSAGES));

    const forms = [
      `commit -m ${message}`,
      `commit -m ${message}`,
      `commit -am ${message}`,
      `commit -a -m ${message}`,
      `commit --allow-empty -m ${message}`,
      `commit --amend -m ${message}`,
      `commit --amend --no-edit`,
      `commit -m ${message} -m ${quote(r.pick(MESSAGES))}`,
      `commit -m ''`,
      `commit -q -m ${message}`,
      `commit -m ${message} -- ${quote(path(this.#name()))}`,
      `commit --no-verify -m ${message}`,
    ];

    this.#world.commits += 1;

    return this.#git("commit", r.pick(forms));
  }

  #branches(): Case {
    const r = this.#random;
    const { branches } = this.#world;
    const existing = (): string => (branches.length > 0 ? r.pick(branches) : "main");

    const fresh = (): string => {
      this.#world.made += 1;

      const name = `${r.pick(["b", "feat/f", "x-"])}${this.#world.made}`;

      branches.push(name);

      return name;
    };

    return r.pick<() => Case>([
      () => this.#git("branch", `branch ${fresh()}`),
      () => this.#git("branch", `branch ${fresh()} HEAD~1`),
      () => this.#git("branch", `checkout -b ${fresh()}`),
      () => this.#git("branch", `switch -c ${fresh()}`),
      () => this.#git("checkout", `checkout ${existing()}`),
      () => this.#git("checkout", `switch ${existing()}`),
      () => this.#git("checkout", "checkout -"),
      () => this.#git("checkout", "checkout --detach"),
      () => this.#git("checkout", "checkout HEAD~1"),
      () => this.#git("branch", `branch -d ${existing()}`),
      () => this.#git("branch", `branch -D ${existing()}`),
      () => this.#git("branch", `branch -m ${existing()} ${fresh()}`),
      () => this.#git("branch", `branch -f ${existing()} HEAD`),
      () => this.#git("checkout", `checkout -B ${fresh()}`),
      () => this.#git("checkout", "checkout nonexistent-branch"),
    ])();
  }

  #reads(): Case {
    const r = this.#random;

    const forms = [
      ...READS,
      `status -s -- ${quote(path(this.#name()))}`,
      `diff -- ${quote(path(this.#name()))}`,
      `diff HEAD~1 HEAD --stat`,
    ];

    return this.#git("read", r.pick(forms), false);
  }

  #history(): Case {
    const r = this.#random;
    const forms = HISTORY;
    const form = r.pick(forms);

    return this.#git(form.startsWith("log") ? "read" : "reset", form, !form.startsWith("log"));
  }

  #branchName(): string {
    this.#world.pushes += 1;

    return `e2e/${this.#runId}-p${this.#world.pushes}`;
  }

  #remote(): Case {
    const r = this.#random;
    const { pushed } = this.#world;
    const old = (): string => (pushed.length > 0 ? r.pick(pushed) : `e2e/${this.#runId}-none`);
    const branch = this.#branchName();

    return r.pick<() => Case>([
      () => {
        pushed.push(branch);

        return this.#git("push", `push origin HEAD:refs/heads/${branch}`);
      },
      () => {
        pushed.push(branch);

        return this.#git("push", `push -u origin HEAD:${branch}`);
      },
      () => this.#git("push", `push origin HEAD:${old()}`),
      () => this.#git("push", `push --force origin HEAD:${old()}`),
      () => this.#git("push", `push origin :${old()}`),
      () =>
        this.#git(
          "push",
          "push origin HEAD:refs/heads/e2e/${runId}-nope".replace("${runId}", this.#runId),
        ),
      () => this.#git("fetch", `fetch origin ${old()}`),
      () => this.#git("fetch", `fetch origin ${old()}:refs/remotes/origin/${old().slice(4)}`),
      () => this.#git("fetch", `fetch origin refs/heads/${old()}`),
      () => this.#git("fetch", `fetch origin e2e/${this.#runId}-missing`),
    ])();
  }
}
