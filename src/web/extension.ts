import { KEY_NOSTR_PRIVATE_KEY } from "./consts";
import { NostrMetadataRepository } from "./nostr";

import * as vscode from "vscode";

import { NostrFetcher } from "nostr-fetch";
import { finishEvent, nip19 } from "nostr-tools";
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
}

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

  const ev = finishEvent(
    {
      content,
      kind: 1,
      tags: [],
      created_at: Math.floor(new Date().getTime() / 1000),
    },
    privkey
  );

  Object.values(rxNostr.getAllRelayState()).filter(
    (state) => state === "ongoing"
  ).length;

  rxNostr
    .send({ content, kind: 1 }, { seckey: privkey })
    .subscribe((packet) => {
      console.log(packet);
    });
};

const handleSyncMetadata = async () => {
  await metadataRepo.resync();
  await rxNostr.switchRelays(metadataRepo.relays);

  vscode.window.showInformationMessage("a", {});
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
