import { Event, finishEvent, nip19, relayInit } from "nostr-tools";
import * as vscode from "vscode";

const KEY_NOSTR_PRIVATE_KEY = "nostr-priv-key";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nostr-client.setPrivKey",
      handleSetPrivateKey(context)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nostr-client.postText",
      handlePostText(context)
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}

const KEY_NOSTR_PRIVATE_KEY = "nostr-priv-key";

const regexp32BytesHexStr = /^[a-f0-9]{64}$/;

// if `pk` is ...
// - bech32-encoded private key ("nsec1...`), validate and convert to hex string.
// - hex string of 32 byte data, leave it as is.
// - otherwise, return `undefined`.
const toHexPrivateKey = (pk: string): string | undefined => {
  if (pk.startsWith("nsec1")) {
    try {
      const res = nip19.decode(pk);
      if (res.type === "nsec") {
        return res.data;
      }
      console.log("toHexPrivateKey: unexpected decode result");
      return undefined;
    } catch (err) {
      console.error(err);
      return undefined;
    }
  }
  return regexp32BytesHexStr.test(pk) ? pk : undefined;
};

const handleSetPrivateKey = (context: vscode.ExtensionContext) => {
  return async () => {
    const k = await context.secrets.get(KEY_NOSTR_PRIVATE_KEY);
    if (k !== undefined) {
      const sel = await vscode.window.showQuickPick(["Yes", "No"], {
        title: "Private key is already set. Is it OK to overwrite?",
      });
      if (sel === "No") {
        return;
      }
    }

    const input = await vscode.window.showInputBox({
      title: "Input your Nostr private key",
      password: true,
      placeHolder: "hex or nsec",
      ignoreFocusOut: true,
    });
    if (!input) {
      return;
    }
    const hexPk = toHexPrivateKey(input);
    if (hexPk === undefined) {
      vscode.window.showErrorMessage("Invalid private key!");
      return;
    }
    console.log(hexPk);
    await context.secrets.store(KEY_NOSTR_PRIVATE_KEY, hexPk);

    vscode.window.showInformationMessage("Saved your Nostr private key!");
  };
};

const publishEvent = async (relayUrl: string, event: Event) => {
  const relay = relayInit(relayUrl);
  await relay.connect();
  await relay.publish(event);

  console.log("published event to", relayUrl);
  relay.close();
};

const handlePostText = (context: vscode.ExtensionContext) => {
  return async () => {
    const privkey = await context.secrets.get(KEY_NOSTR_PRIVATE_KEY);
    if (privkey === undefined) {
      vscode.window.showErrorMessage("Set your Nostr private key first!");
      return;
    }

    const writeRelays = vscode.workspace
      .getConfiguration("nostrClient")
      .get("writeRelays") as string[];
    if (writeRelays.length === 0) {
      vscode.window.showErrorMessage(
        "Please configure write relays to send posts."
      );
    }

    const content = await vscode.window.showInputBox({
      title: "Text to post",
      ignoreFocusOut: true,
    });
    if (!content) {
      return;
    }

    const ev = finishEvent(
      {
        content,
        kind: 1,
        tags: [],
        created_at: Math.floor(new Date().getTime() / 1000),
      },
      privkey
    );

    await Promise.all(writeRelays.map((r) => publishEvent(r, ev)));
  };
};
