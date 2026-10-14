# Using Pi-vot

## Send, Steer, and Queue

When Pi is idle, **Send** starts a new response.

While Pi is working, choose how a new message should be delivered:

- **Steer** delivers it at the next steering boundary so Pi can adjust its current work.
- **Queue** waits until the current request finishes, then starts the queued message as its own turn. Queued messages run in order.

The main button reflects the selected action. Use the small arrow beside it to choose Steer or Queue while Pi is busy. You can change the selection before sending each message.

## Send a batch with `;;;;;`

Paste multiple prompts into the message box and put five semicolons on a line by themselves between prompts:

```text
Summarize this project.
;;;;;
Find the tests for the parser.
;;;;;
Suggest a small improvement.
```

When the selected action is **Send** or **Steer**, Pi-vot delivers the first prompt using that action and queues the remaining prompts in order. When the selected action is **Queue**, every prompt is queued, including the first.

Each non-empty section becomes a separate message. Keep the five semicolons on their own line to avoid splitting text that merely contains semicolons. If images are attached, they are sent with the first prompt.

## Insert a prompt template command

Type `/` in the message box to see prompt template commands available in the current Pi session. Type more letters to filter the list. Use **Up** and **Down** to highlight a command, then press **Tab** to insert its `/command` into the message box. You can also click a command.

Tab only inserts the command; it does not send the message. Add any arguments after the command, then press **Enter** or click the action button. Pi expands the template and its arguments when the message is sent.

For example, select `/review`, add the files or details you want reviewed, and then send it.
