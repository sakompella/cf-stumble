{
  description = "cf-stumble development and verification environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.tailnet-nixpkgs.url = "github:NixOS/nixpkgs/680275f0bb6afce84fbac3e75fc47c5f2272400b";

  outputs =
    { nixpkgs, tailnet-nixpkgs, ... }:
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
            tailnet-nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}.go
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
