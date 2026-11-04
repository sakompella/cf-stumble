{
  description = "cf-stumble development and verification environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            nodejs_22
            pnpm_11
            bash
            dash
            coreutils
            findutils
            gawk
            git
            gnugrep
            gnused
            jq
            perl
          ];
        };
      });
    };
}
