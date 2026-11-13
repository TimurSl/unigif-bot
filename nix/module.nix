# NixOS module: services.unigif-bot
#
# Takes the flake (`self`) so that `package` can default to the flake's own build for the host's system.
# See the README ("Deploy on NixOS") for a walk-through.
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    optionalAttrs
    types
    ;

  cfg = config.services.unigif-bot;

  # systemd puts LoadCredential files here; the bot reads its secrets from them (*_FILE variables), so the
  # bot token and the Unigif key never sit in the process environment or in the Nix store.
  credentialsDir = "/run/credentials/unigif-bot.service";

  environment = {
    UNIGIF_URL = cfg.unigifUrl;
    TELEGRAM_BOT_TOKEN_FILE = "${credentialsDir}/telegram-token";
    UNIGIF_API_KEY_FILE = "${credentialsDir}/unigif-api-key";
    TELEGRAM_API_ROOT = cfg.telegramApiRoot;
    DATA_DIR = "/var/lib/unigif-bot";
    SORT = cfg.sort;
    INLINE_PAGE_SIZE = toString cfg.inlinePageSize;
    CHAT_PAGE_SIZE = toString cfg.chatPageSize;
    INLINE_URL_MAX_BYTES = toString cfg.inlineUrlMaxBytes;
    MAX_UPLOAD_BYTES = toString cfg.maxUploadBytes;
    INLINE_UPLOAD_BUDGET_MS = toString cfg.inlineUploadBudgetMs;
    INLINE_CACHE_SECS = toString cfg.inlineCacheSecs;
    LOG_LEVEL = cfg.logLevel;
    # Node ships its own CA list; this makes it trust the system's instead, including any
    # `security.pki.certificateFiles` (for a Unigif behind a private CA).
    NODE_EXTRA_CA_CERTS = config.security.pki.caBundle;
  }
  // optionalAttrs (cfg.allowedUserIds != [ ]) {
    ALLOWED_USER_IDS = lib.concatMapStringsSep "," toString cfg.allowedUserIds;
  }
  // optionalAttrs cfg.allowAnyone { ALLOW_ANYONE = "true"; }
  // optionalAttrs (cfg.storageChatId != null) { STORAGE_CHAT_ID = toString cfg.storageChatId; };
in
{
  options.services.unigif-bot = {
    enable = mkEnableOption "the Unigif Telegram bot, which searches a Unigif library by hashtag and sends GIFs";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.unigif-bot;
      defaultText = lib.literalExpression "unigif-bot.packages.\${system}.unigif-bot";
      description = "The bot.";
    };

    unigifUrl = mkOption {
      type = types.str;
      example = "http://127.0.0.1:8787";
      description = ''
        Base URL of the Unigif server. The bot fetches GIFs from here, even though Unigif writes its public
        address into media links, so a Unigif on the same machine can be reached on loopback.
      '';
    };

    botTokenFile = mkOption {
      type = types.path;
      example = "/run/agenix/telegram-bot-token";
      description = ''
        File holding the bot token from @BotFather. Read by systemd as root and handed to the service as a
        credential, so it works with agenix and sops-nix and stays out of the Nix store.
      '';
    };

    apiKeyFile = mkOption {
      type = types.path;
      example = "/run/agenix/unigif-bot-key";
      description = ''
        File holding a Unigif API key (`ugf_…`) with the `read` scope. Read by systemd as root.
        `unigif-ctl key create --name telegram --preset read_only` makes one.
      '';
    };

    allowedUserIds = mkOption {
      type = types.listOf types.ints.positive;
      default = [ ];
      example = [ 123456789 ];
      description = ''
        Telegram user ids allowed to use the bot, in private chats and inline. Anyone else is told the bot is
        private and given their own id, which is an easy way to find yours.
      '';
    };

    allowAnyone = mkOption {
      type = types.bool;
      default = false;
      description = "Let anybody on Telegram search your library instead of listing `allowedUserIds`.";
    };

    storageChatId = mkOption {
      type = types.nullOr (types.either types.int types.str);
      default = null;
      example = -1001234567890;
      description = ''
        A private chat or channel the bot can post in (make the bot an administrator of a private channel).
        GIFs too big to hand to Telegram by URL are uploaded there once and then answered from the file id
        Telegram returns. Without it such GIFs appear in inline mode only as their smaller preview.
      '';
    };

    sort = mkOption {
      type = types.enum [
        "used"
        "new"
        "old"
      ];
      default = "used";
      description = "Order of results: most used first, newest first or oldest first.";
    };

    inlinePageSize = mkOption {
      type = types.ints.between 1 50;
      default = 30;
      description = "Results per inline page.";
    };

    chatPageSize = mkOption {
      type = types.ints.between 1 10;
      default = 5;
      description = "GIFs sent per search in a chat with the bot.";
    };

    inlineUrlMaxBytes = mkOption {
      type = types.ints.unsigned;
      default = 1000000;
      description = "Largest MP4 given to Telegram as a URL in an inline result; bigger ones are uploaded to the storage chat.";
    };

    maxUploadBytes = mkOption {
      type = types.ints.positive;
      default = 20000000;
      description = "Largest MP4 the bot downloads from Unigif to upload to Telegram.";
    };

    inlineUploadBudgetMs = mkOption {
      type = types.ints.unsigned;
      default = 4000;
      description = "How long an inline query waits for uploads before answering with what is ready.";
    };

    inlineCacheSecs = mkOption {
      type = types.ints.unsigned;
      default = 30;
      description = "How long Telegram may cache an inline answer.";
    };

    telegramApiRoot = mkOption {
      type = types.str;
      default = "https://api.telegram.org";
      description = "Where the Bot API lives. Change it to use a self-hosted Bot API server.";
    };

    logLevel = mkOption {
      type = types.enum [
        "debug"
        "info"
        "warn"
        "error"
      ];
      default = "info";
      description = "Log verbosity.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "A systemd `EnvironmentFile` with extra variables from the README's configuration table. Read by systemd as root.";
    };

    resources = {
      memoryMax = mkOption {
        type = types.str;
        default = "512M";
        description = "systemd `MemoryMax`. GIFs are held in memory while they are uploaded.";
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.allowedUserIds != [ ] || cfg.allowAnyone;
        message = "services.unigif-bot: set allowedUserIds, or allowAnyone = true to let everybody search the library.";
      }
      {
        assertion = !(cfg.allowedUserIds != [ ] && cfg.allowAnyone);
        message = "services.unigif-bot: allowedUserIds and allowAnyone are alternatives; set only one.";
      }
      {
        assertion = lib.hasPrefix "http://" cfg.unigifUrl || lib.hasPrefix "https://" cfg.unigifUrl;
        message = "services.unigif-bot.unigifUrl must be an http(s) URL such as http://127.0.0.1:8787.";
      }
    ];

    systemd.services.unigif-bot = {
      description = "Unigif Telegram bot";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      # Ordering only: harmless when Unigif runs on another machine, or is not managed by NixOS.
      after = [
        "network-online.target"
        "unigif.service"
      ];
      inherit environment;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = "10s";

        DynamicUser = true;
        StateDirectory = "unigif-bot";
        StateDirectoryMode = "0700";
        EnvironmentFile = mkIf (cfg.environmentFile != null) cfg.environmentFile;
        LoadCredential = [
          "telegram-token:${toString cfg.botTokenFile}"
          "unigif-api-key:${toString cfg.apiKeyFile}"
        ];

        MemoryMax = cfg.resources.memoryMax;
        TasksMax = 128;

        # Hardening. Everything the bot does is HTTPS out and one small file in its state directory.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateUsers = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        # Not MemoryDenyWriteExecute: Node's JIT needs memory that is writable and executable.
        RemoveIPC = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        DevicePolicy = "closed";
        UMask = "0077";
      };
    };
  };
}
