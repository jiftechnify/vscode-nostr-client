import { NostrSystem, toHexPrivateKey } from "./nostr";

import * as vscode from "vscode";
import { l10n } from "vscode";

import { currUnixtime, mapFalsyToUndefined } from "./utils";

let nostrSystem: NostrSystem;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  for (const [command, handler] of commandMap) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, handler)
    );
  }
  nostrSystem = await NostrSystem.init(context);
}

// This method is called when your extension is deactivated
export async function deactivate() {
  nostrSystem.dispose();
}

const commandMap: [string, (...args: unknown[]) => unknown][] = [
  ["nostr-client.postText", handlePostText],
  ["nostr-client.updateStatus", handleUpdateStatus],
  ["nostr-client.updateStatusWithLink", handleUpdateStatusWithLink],
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
  if (await nostrSystem.isPrivatekeySet()) {
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
    vscode.window.showErrorMessage(l10n.t("Invalid private key!")).then(
      () => {},
      (err) => {
        console.error(err);
      }
    );
    return;
  }

  await nostrSystem.updatePrivateKey(privkey);
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

  await nostrSystem.postText(content);
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
  const input = await vscode.window.showInputBox({
    title: l10n.t("Set your status"),
    value: nostrSystem.userStatus.status,
    ignoreFocusOut: true,
  });
  return mapFalsyToUndefined(input);
};

const getLinkUrlInput = async () => {
  const input = await vscode.window.showInputBox({
    title: l10n.t("Set link URL"),
    value: nostrSystem.userStatus.linkUrl,
    ignoreFocusOut: true,
  });
  return mapFalsyToUndefined(input);
};

const getStatusExpirationInput = async () => {
  return await vscode.window.showQuickPick(secsUntilExpirationChoices, {
    title: l10n.t("Clear status after..."),
  });
};

async function updateStatusFlow({ withLinkUrl }: { withLinkUrl: boolean }) {
  const privkey = await checkPrivateKeyFlow();
  if (!privkey) {
    return;
  }

  const status = await getStatusInput();
  if (status === undefined) {
    return;
  }

  const linkUrl = withLinkUrl ? await getLinkUrlInput() : "";
  if (linkUrl === undefined) {
    return;
  }

  const expInput = await getStatusExpirationInput();
  if (expInput === undefined) {
    return;
  }
  const expiration =
    expInput.dur !== undefined ? currUnixtime() + expInput.dur : undefined;

  await nostrSystem.updateUserStatus({ status, linkUrl, expiration });
}

async function handleUpdateStatus() {
  await updateStatusFlow({ withLinkUrl: false });
}

async function handleUpdateStatusWithLink() {
  await updateStatusFlow({ withLinkUrl: true });
}

async function handleSyncMetadata() {
  await nostrSystem.syncStatesWithRelays({ syncMetadata: true });
}

async function handleClearPrivateKey() {
  await nostrSystem.clearPrivateKey();
}

async function handleDebug() {
  console.log("pubkey:", await nostrSystem.getPublicKey());
  console.log("profile:", nostrSystem.profile);
  console.log("releys:", nostrSystem.relays);
  console.log("rx-nostr relay states:", nostrSystem.relayStates);
  console.log("user status:", nostrSystem.userStatus);
}

const buttonsInNoPrivKeyMsg: (vscode.MessageItem & { ok: boolean })[] = [
  { title: l10n.t("Set Private Key"), ok: true },
  { title: l10n.t("Dismiss"), ok: false },
];

// checks private key is set. if not, show error message with "Set Private Key" button.
// when the button is clicked, execute setPrivKey command.
const checkPrivateKeyFlow = async (): Promise<string | undefined> => {
  const privkey = await nostrSystem.getPrivateKey();
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
