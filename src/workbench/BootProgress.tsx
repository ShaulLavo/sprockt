// What the workbench shows while a workspace boots: its steps, done, running or waiting.
import { For, Match, Show, Switch } from "solid-js";
import type { BootStage } from "../runtime/boot";
import { fill } from "../ui/format";
import { Icon } from "../ui/icons";
import { workspaceName } from "../workspace/hint";
import { bootSteps } from "./boot-steps";
import { ui } from "./copy";

export function BootProgress(props: { workspaceId: string; stage: BootStage; error?: string }) {
  return (
    <div class="wb-boot" data-testid="boot-progress">
      <div class="wb-boot-card" role="status" aria-live="polite">
        <span class="wb-boot-mark" aria-hidden="true">
          <Icon name="logo" />
        </span>
        <p class="wb-boot-title">{workspaceName(props.workspaceId)}</p>
        <ol class="wb-boot-steps">
          <For each={bootSteps(props.stage, Boolean(props.error))}>
            {(step) => (
              <li data-state={step.state}>
                <span class="wb-boot-icon" aria-hidden="true">
                  <Switch fallback={<span class="wb-boot-dot" />}>
                    <Match when={step.state === "done"}>
                      <Icon name="check" />
                    </Match>
                    <Match when={step.state === "active"}>
                      <span class="wb-spinner" />
                    </Match>
                    <Match when={step.state === "failed"}>
                      <Icon name="alert" />
                    </Match>
                  </Switch>
                </span>
                <span>{step.label}</span>
              </li>
            )}
          </For>
        </ol>
        <Show when={props.error}>
          {(message) => (
            <p class="pane-error wb-boot-error" data-testid="boot-error">
              {fill(ui.errors.bootFailed, { message: message() })}
            </p>
          )}
        </Show>
      </div>
    </div>
  );
}
