# Set up the assistant

The bench assistant is optional and off by default. The Settings dialog cannot do some tasks for you.
This page covers four of them: getting a key, installing a local model, reaching a model on another
machine and testing the connection. Do the test before you ask a real question. To turn the assistant on, open Settings,
Assistant. First read [Settings and privacy](settings-and-privacy), which says what the app sends and
where.

There are three profiles: **Local**, for a model on this computer, and two cloud slots. Each profile has
its own server address, model and key. Pick the profile in the dialog and fill it in. Then press
**Save** and press **Test this profile**. The switch at the top of the Agent panel chooses which profile
answers.

## A cloud model (the two cloud slots)

The two cloud slots work the same way. Use them to keep two models ready and to switch with one click. For
example, keep a cheap model for everyday questions and a stronger model for a careful reading of a board.
The slots start as **Quick** and **Thorough**. To rename a slot, type a name that means something to you in
the **Name** field, such as Cheap and Expensive.

The suggested models use [OpenRouter](https://openrouter.ai). One account there reaches many models.

1. Make an account and add credit.
2. Create a key at <https://openrouter.ai/keys>.
3. In Settings, Assistant, pick a cloud slot.
4. Set the server address to `https://openrouter.ai/api/v1`.
5. Paste the key and save.

The Model field shows the suggested model names as placeholders. Both models read photos.

A cloud server charges for each use. The line under the Agent panel and in the dialog shows how many
questions and tokens a profile has used. It also shows the cost, which it calculates from the prices that
you entered. The app sends your questions and the board data that they use to that server. The server may
keep them under its own terms.

## A model on this computer (Local)

Ollama runs models on your own machine. Nothing leaves the computer, and you need no key.

```
sudo pacman -S ollama
sudo systemctl enable --now ollama
ollama pull llama3.2:3b
```

In Settings, Assistant, pick Local. Set the address to `http://localhost:11434/v1` and the model to
`llama3.2:3b`. That model is small enough for a laptop. It reads text only. To let the assistant look at
photos, pull a vision model and tick *Send photos to this model*.

## A model on another machine

An address that is not on this computer must use `https://`, and a plain Ollama server speaks `http`. The
supported solution is an SSH tunnel. It makes the Ollama server of the other machine appear on your own
`localhost`. In a terminal on this computer, run:

```
ssh -N -L 11434:localhost:11434 <host>
```

Leave the command running. Then use the address `http://localhost:11434/v1` in the profile. If you close
the tunnel, the app cannot reach the profile, and the test says so.

## How much it does per question

*Effort per question* in the profile settings sets how many steps the assistant may take before it
answers. *Normal* allows up to 8 steps. *Deep* allows up to 24 steps and longer answers. Deep lets the
assistant look at more of the board. On a paid server, one question can then cost several times as much.
The usage line shows the cost. Every command still needs your approval.

The two settings answer different questions. The profile that you pick in the Agent panel chooses **which
model** answers, and so what a question costs. Effort per question chooses **how many steps** that model
may take for one question.

## Test this profile

The button sends one short question, "Reply with the word ok.", to the saved settings of the profile. It
also sends the descriptions of the tools of the assistant, to check that the model can use them. It sends
no board data and no photos. On a paid server, it costs a fraction of a cent. It counts in the usage
line. The result is one of these:

- **It works.** The server answered with the model that the dialog shows.
- **It works, but the model thought first.** This is normal for a thinking model. Real questions get a
  longer reply.
- **The model wrote nothing.** Try again, or try another model.
- **This model cannot use tools.** Pick a model that can. The assistant needs tools for every question.
- **The server refused the key.** The key is wrong or expired, or the account has no credit.
- **The server does not know this model name.** Check the spelling. Check that the address ends in `/v1`.
- **Could not reach the server.** Check the address, the network, that the server runs, and the tunnel.
- **The server did not answer in time.** A local model can take a minute to load the first time.

## The system keyring

The app stores keys in your system keyring, never in a board or in the settings file. On Plasma, the
keyring is KWallet. If the dialog says that the keyring is not available, open KWallet Manager and make
sure that a wallet exists and is open. You can also log out and log in again. Until the keyring works,
the key field stays disabled. A Local profile that needs no key works without a keyring.
