import { KEY_NOSTR_PRIVATE_KEY } from "./consts";
import { NostrMetadataRepository, toHexPrivateKey } from "./nostr";

import * as vscode from "vscode";

import { NostrFetcher } from "nostr-fetch";
import { createRxNostr } from "rx-nostr";

let metadataRepo: NostrMetadataRepository;
const rxNostr = createRxNostr();

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("nostr-client.postText", handlePostText)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nostr-client.setPrivKey",
      handleSetPrivateKey(context)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nostr-client.clearPrivkey",
      handleClearPrivkey
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nostr-client.syncMetadata",
      handleSyncMetadata
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nostr-client.debug", handleDebug)
  );

  metadataRepo = await NostrMetadataRepository.init(
    context,
    NostrFetcher.init()
  );
  await rxNostr.switchRelays(metadataRepo.relays);
}

// This method is called when your extension is deactivated
export function deactivate() {
  metadataRepo.dispose();
  rxNostr.dispose();
}

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
    const privkey = toHexPrivateKey(input);
    if (privkey === undefined) {
      vscode.window.showErrorMessage("Invalid private key!");
      return;
    }
    await metadataRepo.updatePrivateKey(privkey);
    vscode.window.showInformationMessage("Saved your Nostr private key!");

    await metadataRepo.resync();
    await rxNostr.switchRelays(metadataRepo.relays);
  };
};

const handlePostText = async () => {
  const privkey = await metadataRepo.getPrivateKey();
  if (privkey === undefined) {
    vscode.window.showErrorMessage("Set your Nostr private key first!");
    return;
  }

  const content = await vscode.window.showInputBox({
    title: "Text to post",
    ignoreFocusOut: true,
  });
  if (!content) {
    return;
  }

  rxNostr
    .send({ content, kind: 1 }, { seckey: privkey })
    .subscribe((packet) => {
      console.log(packet);
    });
};

const handleSyncMetadata = async () => {
  await metadataRepo.resync();
  await rxNostr.switchRelays(metadataRepo.relays);
};

const handleClearPrivkey = async () => {
  await metadataRepo.clear();
  await rxNostr.switchRelays({});
};

const handleDebug = async () => {
  console.log(await metadataRepo.getPublicKey());
  console.log(metadataRepo.profile);
  console.log(metadataRepo.relays);
  console.log(rxNostr.getAllRelayState());
};
