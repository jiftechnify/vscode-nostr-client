import { NostrMetadataRepository, toHexPrivateKey } from "./nostr";

import * as vscode from "vscode";

import { NostrFetcher } from "nostr-fetch";
import { createRxNostr } from "rx-nostr";
import { currUnixtime } from "./utils";

let metadataRepo: NostrMetadataRepository;
const rxNostr = createRxNostr();

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  for (const [command, handler] of commandMap) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, handler)
    );
  }

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

const commandMap: [string, (...args: unknown[]) => unknown][] = [
  ["nostr-client.postText", handlePostText],
  ["nostr-client.updateStatus", handleUpdateStatus],
  ["nostr-client.setPrivKey", handleSetPrivateKey],
  ["nostr-client.clearPrivKey", handleClearPrivateKey],
  ["nostr-client.syncMetadata", handleSyncMetadata],
  ["nostr-client.debug", handleDebug],
];

async function handleSetPrivateKey() {
  if (await metadataRepo.isPrivatekeySet()) {
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
}

async function handlePostText() {
  const privkey = await metadataRepo.getPrivateKey();
  if (privkey === undefined) {
    vscode.window.showErrorMessage("Set your Nostr private key first!");
    return;
  }

  const content = await vscode.window.showInputBox({
    title: "Text to post",
    placeHolder: "What's on your mind?",
    ignoreFocusOut: true,
  });
  if (!content) {
    return;
  }

  const ev = {
    kind: 1,
    content,
  };
  console.log("sending event: %O", ev);
  rxNostr.send(ev, { seckey: privkey }).subscribe((packet) => {
    console.log(packet);
  });
}

const secsUntilExpirationTable = new Map<string, number | undefined>([
  ["Don't clear", undefined],
  ["10 Minutes", 10 * 60],
  ["30 Minutes", 30 * 60],
  ["1 Hour", 60 * 60],
  ["4 Hours", 4 * 60 * 60],
  ["1 Day", 24 * 60 * 60],
]);

async function handleUpdateStatus() {
  const privkey = await metadataRepo.getPrivateKey();
  if (privkey === undefined) {
    vscode.window.showErrorMessage("Set your Nostr private key first!");
    return;
  }

  const status = await vscode.window.showInputBox({
    title: "Set your status",
    value: metadataRepo.userStatus,
    ignoreFocusOut: true,
  });
  if (!status || status === metadataRepo.userStatus) {
    return;
  }

  const untilExpStr = await vscode.window.showQuickPick(
    [...secsUntilExpirationTable.keys()],
    { title: "Clear status after..." }
  );
  if (!untilExpStr) {
    return;
  }
  const untilExpSecs = secsUntilExpirationTable.get(untilExpStr);
  const exp =
    untilExpSecs !== undefined ? currUnixtime() + untilExpSecs : undefined;

  const statusEv = {
    kind: 30315,
    content: status,
    tags: [
      ["d", "general"],
      ...(exp !== undefined ? [["expiration", String(exp)]] : []),
    ],
  };
  console.log("sending event: %O", statusEv);
  rxNostr.send(statusEv, { seckey: privkey }).subscribe((packet) => {
    console.log(packet);
  });
  metadataRepo.updateUserStatus(status, exp);
}

async function handleSyncMetadata() {
  await metadataRepo.resync();
  await rxNostr.switchRelays(metadataRepo.relays);
}

async function handleClearPrivateKey() {
  await metadataRepo.clear();
  await rxNostr.switchRelays({});
}

async function handleDebug() {
  console.log(await metadataRepo.getPublicKey());
  console.log(metadataRepo.profile);
  console.log(metadataRepo.relays);
  console.log(rxNostr.getAllRelayState());
}
