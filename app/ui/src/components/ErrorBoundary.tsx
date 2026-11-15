import { Component, type ErrorInfo, type ReactNode } from "react";
import { saveModel } from "../actions/edit";
import { getState } from "../store";

interface Caught {
  error: unknown;
  componentStack: string;
}

/** The text of an error and its stacks, to read or copy into a bug report. */
function errorText({ error, componentStack }: Caught): string {
  const e = error instanceof Error ? error : null;
  const head = e ? `${e.name}: ${e.message}` : String(error);
  const stack = e?.stack ? e.stack.replace(head, "").trim() : "";
  return [head, stack && `\nStack:\n${stack}`, componentStack.trim() && `\nComponents:\n${componentStack.trim()}`].filter(Boolean).join("\n");
}

/**
 * Catches an error thrown while rendering the app. Without it React unmounts the whole
 * tree and the window is left empty; here the error is shown, with ways to go on: render
 * again (the model and the results are kept in the store), save the model, or reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { caught: Caught | null; copied: boolean }> {
  state = { caught: null as Caught | null, copied: false };

  static getDerivedStateFromError(error: unknown) {
    return { caught: { error, componentStack: "" }, copied: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ caught: { error, componentStack: info.componentStack ?? "" } });
    console.error("SWMM Studio: render error", error, info.componentStack);
  }

  render() {
    const { caught, copied } = this.state;
    if (!caught) return this.props.children;
    const text = errorText(caught);
    const model = getState().model;
    return (
      <div className="crash">
        <h2>Something went wrong in the interface</h2>
        <p>
          The error below stopped the display. The model{model ? ` (${model.name})` : ""} and its results are still loaded: “Try again” shows them
          again, which works if the error does not come back.
        </p>
        <div className="crash-actions">
          <button className="primary" onClick={() => this.setState({ caught: null })}>
            Try again
          </button>
          {model?.dirty && (
            <button className="dirty" onClick={() => void saveModel()} title="Save the changes before reloading">
              Save {model.name}
            </button>
          )}
          <button
            onClick={() =>
              navigator.clipboard.writeText(text).then(
                () => this.setState({ copied: true }),
                () => {},
              )
            }
          >
            {copied ? "Copied" : "Copy the error"}
          </button>
          <button className={model?.dirty ? "danger" : ""} onClick={() => location.reload()} title={model?.dirty ? "Unsaved changes are lost" : undefined}>
            Reload the app
          </button>
        </div>
        <pre className="crash-text">{text}</pre>
      </div>
    );
  }
}
