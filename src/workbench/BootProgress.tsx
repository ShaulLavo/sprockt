// What the workbench shows while a workspace boots: its steps, done, running or waiting.
import type { BootStage } from "../runtime/boot";
import { fill } from "../ui/format";
import { Icon } from "../ui/icons";
import { workspaceName } from "../workspace/hint";
import { bootSteps, type StepState } from "./boot-steps";
import { ui } from "./copy";

function StepIcon(props: { state: StepState }) {
  if (props.state === "done") return <Icon name="check" />;
  if (props.state === "active") return <span className="wb-spinner" />;
  if (props.state === "failed") return <Icon name="alert" />;
  return <span className="wb-boot-dot" />;
}

export function BootProgress(props: { workspaceId: string; stage: BootStage; error?: string }) {
  return (
    <div className="wb-boot" data-testid="boot-progress">
      <div className="wb-boot-card" role="status" aria-live="polite">
        <span className="wb-boot-mark" aria-hidden="true">
          <Icon name="logo" />
        </span>
        <p className="wb-boot-title">{workspaceName(props.workspaceId)}</p>
        <ol className="wb-boot-steps">
          {bootSteps(props.stage, Boolean(props.error)).map((step) => (
            <li key={step.stage} data-state={step.state}>
              <span className="wb-boot-icon" aria-hidden="true">
                <StepIcon state={step.state} />
              </span>
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
        {props.error ? (
          <p className="pane-error wb-boot-error" data-testid="boot-error">
            {fill(ui.errors.bootFailed, { message: props.error })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
