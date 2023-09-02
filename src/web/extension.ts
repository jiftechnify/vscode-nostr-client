import { NostrMetadataRepository, toHexPrivateKey } from "./nostr";

import * as vscode from "vscode";
import { l10n } from "vscode";

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
  ["nostr-client.updateStatusWithLink", handleUpdateWithLink],
  ["nostr-client.setPrivKey", handleSetPrivateKey],
  ["nostr-client.clearPrivKey", handleClearPrivateKey],
  ["nostr-client.syncMetadata", handleSyncMetadata],
  ["nostr-client.debug", handleDebug],
];

const yesNoChoices: (vscode.QuickPickItem & { ok: boolean })[] = [
  { label: l10n.t("Yes"), ok: true },
  { label: l10n.t("No"), ok: false },
];

async function handleSetPrivateKey() {
  if (await metadataRepo.isPrivatekeySet()) {
    const sel = await vscode.window.showQuickPick(yesNoChoices, {
      title: l10n.t("Private key is already set. Is it OK to overwrite?"),
    });
    if (sel === undefined || !sel.ok) {
      return;
    }
  }

  const input = await vscode.window.showInputBox({
    title: l10n.t("Input your Nostr private key"),
    password: true,
    placeHolder: l10n.t("hex or nsec"),
    ignoreFocusOut: true,
  });
  if (!input) {
    return;
  }
  const privkey = toHexPrivateKey(input);
  if (privkey === undefined) {
    vscode.window.showErrorMessage(l10n.t("Invalid private key!"));
    return;
  }

  await metadataRepo.updatePrivateKey(privkey);
  await metadataRepo.resync();
  await rxNostr.switchRelays(metadataRepo.relays);
}

async function handlePostText() {
  const privkey = await checkPrivateKeyFlow();
  if (!privkey) {
    return;
  }

  const content = await vscode.window.showInputBox({
    title: l10n.t("Text to post"),
    placeHolder: l10n.t("What's on your mind?"),
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

const secsUntilExpirationChoices: (vscode.QuickPickItem & {
  dur: number | undefined;
})[] = [
  { label: l10n.t("Don't clear"), dur: undefined },
  { label: l10n.t("10 Minutes"), dur: 10 * 60 },
  { label: l10n.t("30 Minutes"), dur: 30 * 60 },
  { label: l10n.t("1 Hour"), dur: 60 * 60 },
  { label: l10n.t("4 Hours"), dur: 4 * 60 * 60 },
  { label: l10n.t("1 Day"), dur: 24 * 60 * 60 },
];

const getStatusInput = async () => {
  return vscode.window.showInputBox({
    title: l10n.t("Set your status"),
    value: metadataRepo.userStatus.status,
    ignoreFocusOut: true,
  });
};

const getStatusExpirationInput = async () => {
  return await vscode.window.showQuickPick(secsUntilExpirationChoices, {
    title: l10n.t("Clear status after..."),
  });
};

const composeUserStatus = ({
  status,
  linkUrl = "",
  expiration: exp,
}: {
  status: string;
  linkUrl?: string;
  expiration?: number;
}) => {
  return {
    kind: 30315,
    content: status,
    tags: [
      ["d", "general"],
      ...(linkUrl !== "" ? [["r", linkUrl]] : []),
      ...(exp !== undefined ? [["expiration", String(exp)]] : []),
    ],
  };
};

async function handleUpdateStatus() {
  const privkey = await checkPrivateKeyFlow();
  if (!privkey) {
    return;
  }

  const status = await getStatusInput();
  if (!status) {
    return;
  }

  const expInput = await getStatusExpirationInput();
  if (expInput === undefined) {
    return;
  }
  const expiration =
    expInput.dur !== undefined ? currUnixtime() + expInput.dur : undefined;

  const statusEv = composeUserStatus({ status, expiration });
  console.log("sending event: %O", statusEv);
  rxNostr.send(statusEv, { seckey: privkey }).subscribe((packet) => {
    console.log(packet);
  });

  metadataRepo.updateUserStatus({ status, expiration });
}

async function handleUpdateWithLink() {
  const privkey = await checkPrivateKeyFlow();
  if (!privkey) {
    return;
  }

  const status = await getStatusInput();
  if (!status) {
    return;
  }

  const linkUrl = await vscode.window.showInputBox({
    title: l10n.t("Set link URL"),
    value: metadataRepo.userStatus.linkUrl,
    ignoreFocusOut: true,
  });
  if (!linkUrl) {
    return;
  }

  const expInput = await getStatusExpirationInput();
  if (expInput === undefined) {
    return;
  }
  const expiration =
    expInput.dur !== undefined ? currUnixtime() + expInput.dur : undefined;

  const statusEv = composeUserStatus({ status, linkUrl, expiration });
  console.log("sending event: %O", statusEv);
  rxNostr.send(statusEv, { seckey: privkey }).subscribe((packet) => {
    console.log(packet);
  });

  metadataRepo.updateUserStatus({ status, linkUrl, expiration });
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

const buttonsInNoPrivKeyMsg: (vscode.MessageItem & { ok: boolean })[] = [
  { title: l10n.t("Set Private Key"), ok: true },
  { title: l10n.t("Dismiss"), ok: false },
];

// checks private key is set. if not, show error message with "Set Private Key" button.
// when the button is clicked, execute setPrivKey command.
const checkPrivateKeyFlow = async (): Promise<string | undefined> => {
  const privkey = await metadataRepo.getPrivateKey();
  if (privkey === undefined) {
    const sel = await vscode.window.showErrorMessage(
      l10n.t("Set your Nostr private key first!"),
      ...buttonsInNoPrivKeyMsg
    );
    if (sel === undefined || !sel.ok) {
      return undefined;
    }
    // "Set Private Key" is selected -> run setPrivKey
    await vscode.commands.executeCommand("nostr-client.setPrivKey");
    return undefined;
  }

  return privkey;
};
