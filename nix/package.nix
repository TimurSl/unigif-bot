# The bot, built from package-lock.json: `npm ci`, compile with tsc, run the tests, keep only the
# production dependencies. Installs `bin/unigif-bot`.
{
  lib,
  buildNpmPackage,
  nodejs,
}:

buildNpmPackage {
  pname = "unigif-bot";
  version = (lib.importJSON ../package.json).version;

  inherit nodejs;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../test
      ../LICENSE
    ];
  };

  npmDepsHash = "sha256-B5maHpkiJToQ93B+QYhUuKIFUf+AKooj9ojCPSCMZYY=";

  npmBuildScript = "build";

  # The unit and handler tests run here; the end-to-end ones need a Unigif binary and skip themselves.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  meta = {
    description = "Telegram bot that searches a Unigif GIF library by hashtag and sends GIFs, inline or in chat";
    homepage = "https://github.com/TimurSl/unigif-bot";
    license = lib.licenses.mit;
    mainProgram = "unigif-bot";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
