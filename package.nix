{ lib, stdenvNoCC, bun, nodejs, makeWrapper, writableTmpDirAsHomeHook }:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "mdpx";
  version = (lib.importJSON ./package.json).version;

  src = ./.;

  node_modules = stdenvNoCC.mkDerivation {
    pname = "${finalAttrs.pname}-node_modules";
    inherit (finalAttrs) version src;

    nativeBuildInputs = [ bun nodejs writableTmpDirAsHomeHook ];

    # bun 1.3's streaming extraction intermittently fails on the mermaid tarball.
    env.BUN_FEATURE_FLAG_DISABLE_STREAMING_INSTALL = "1";

    dontConfigure = true;

    # TypeScript ships a native binary per platform; fetching both Darwin ones lets a single hash serve every system.
    # bun can drop a package whose tarball failed to extract, so verify the tree before it gets hashed.
    buildPhase = ''
      runHook preBuild
      bun install --frozen-lockfile --ignore-scripts --no-progress --linker=hoisted --os=darwin --cpu='*'
      npm ls --all --offline > /dev/null
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      cp -R node_modules $out
      runHook postInstall
    '';

    dontFixup = true;

    outputHash = "sha256-u/e5JUzuzz8AOil99qvMJjbdfzuQoJ3PG0ueJmHuQjA=";
    outputHashMode = "recursive";
  };

  nativeBuildInputs = [ nodejs makeWrapper writableTmpDirAsHomeHook ];

  buildPhase = ''
    runHook preBuild
    cp -R ${finalAttrs.node_modules} node_modules
    chmod -R u+w node_modules
    node node_modules/typescript/bin/tsc -p tsconfig.build.json
    npm prune --omit=dev --offline --ignore-scripts --no-package-lock --no-audit --no-fund
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/mdpx
    cp -R dist node_modules package.json $out/lib/mdpx
    makeWrapper ${lib.getExe nodejs} $out/bin/mdpx --add-flags $out/lib/mdpx/dist/main.js
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    usage=$($out/bin/mdpx 2>&1 || true)
    grep -q "usage: mdpx" <<< "$usage"
    runHook postInstallCheck
  '';

  meta.mainProgram = "mdpx";
})
