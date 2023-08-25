# vscode-nostr-client

A Nostr client in VSCode!

## Usage

### Prerequisite: Setting Private Key
First, set your Nostr private key. Open the command palette then run `Nostr: Set Private Key`. Hex key and `nsec` are supported!

### Post
Just run `Nostr: Post Text` command!


## Notes
- this extension uses `vscode.SecretStorage` to store your private key. It is encrypted and finally stored in OS keyring. However, **it is not guaranteed that stored key won't be peeked by other (malicious) extension**. Please keep in mind that, and use this extension at your own risk.
