# Boots a NixOS VM with the module and drives the real service against a fake Telegram and a fake Unigif
# (nix/fake-backend.py), the way the production unit runs: DynamicUser, systemd credentials, hardening.
{ self, pkgs }:

pkgs.testers.runNixOSTest {
  name = "unigif-bot";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.default ];

      services.unigif-bot = {
        enable = true;
        unigifUrl = "http://127.0.0.1:8787";
        telegramApiRoot = "http://127.0.0.1:8081";
        botTokenFile = pkgs.writeText "bot-token" "123456:VMTESTTOKENVMTESTTOKENVMTESTTOKEN1\n";
        apiKeyFile = pkgs.writeText "unigif-key" "ugf_vmtest_secret\n";
        allowedUserIds = [ 1 ];
        logLevel = "debug";
      };

      systemd.services.fake-backend = {
        wantedBy = [ "multi-user.target" ];
        before = [ "unigif-bot.service" ];
        serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${./fake-backend.py}";
      };
    };

  testScript = ''
    import json

    machine.start()
    machine.wait_for_unit("fake-backend.service")
    machine.wait_for_open_port(8081)
    machine.wait_for_unit("unigif-bot.service")

    with subtest("the bot answers an inline query from the Unigif library"):
        machine.wait_until_succeeds("grep -q answerInlineQuery /tmp/telegram-calls.log", timeout=60)
        answer = json.loads(machine.succeed("cat /tmp/answer.json"))
        results = json.loads(answer["results"]) if isinstance(answer["results"], str) else answer["results"]
        assert [r["id"] for r in results] == ["aaaaaaaaaaaa"], results
        assert results[0]["mpeg4_url"].endswith("/m/aaaaaaaaaaaa/full.mp4"), results

    with subtest("a chat message is answered with the GIF, downloaded from the configured Unigif URL"):
        machine.wait_until_succeeds("grep -q sendAnimation /tmp/telegram-calls.log", timeout=60)
        machine.succeed("grep -q /m/aaaaaaaaaaaa/full.mp4 /tmp/unigif-downloads.log")

    with subtest("the Telegram file id is remembered in the state directory"):
        machine.wait_until_succeeds("grep -q VMFILE1 /var/lib/private/unigif-bot/file-ids.json", timeout=30)

    with subtest("secrets are credentials, not environment"):
        pid = machine.succeed("systemctl show -p MainPID --value unigif-bot.service").strip()
        env = machine.succeed(f"tr '\\0' '\\n' < /proc/{pid}/environ")
        assert "VMTESTTOKEN" not in env and "ugf_vmtest_secret" not in env, env
        assert "TELEGRAM_BOT_TOKEN_FILE=/run/credentials/unigif-bot.service/telegram-token" in env, env

    with subtest("the unit is sandboxed"):
        show = machine.succeed(
            "systemctl show unigif-bot.service -p DynamicUser -p NoNewPrivileges -p ProtectSystem -p PrivateTmp -p CapabilityBoundingSet"
        )
        assert "DynamicUser=yes" in show and "NoNewPrivileges=yes" in show and "ProtectSystem=strict" in show, show
        score = machine.succeed("systemd-analyze security unigif-bot.service --no-pager | tail -1")
        print(score)

    with subtest("it never ran as root"):
        user = machine.succeed("ps -o user= -p $(systemctl show -p MainPID --value unigif-bot.service)").strip()
        assert user != "root", user
  '';
}
