{
  description = "unigif-bot: a Telegram bot for a Unigif GIF library";

  # A channel tarball rather than `github:NixOS/nixpkgs/...`: it locks the same way and also works where
  # only the channel host is reachable. Same channel as Unigif, so the two share a nixpkgs.
  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        unigif-bot = pkgs.callPackage ./nix/package.nix { };
        default = unigif-bot;
      });

      nixosModules.default = import ./nix/module.nix self;

      overlays.default = final: _prev: {
        unigif-bot = final.callPackage ./nix/package.nix { };
      };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs ];
          shellHook = ''
            echo "unigif-bot dev shell: npm ci && npm test   |   npm run dev (reads .env)"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      checks = forAllSystems (pkgs: {
        # Building the package runs the unit and handler tests.
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.unigif-bot;
        # Boots a NixOS VM with the module, a fake Unigif and a fake Telegram, and drives the real service.
        vm = import ./nix/vm-test.nix { inherit self pkgs; };
      });
    };
}
