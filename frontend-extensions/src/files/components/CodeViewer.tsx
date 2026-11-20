import { Fragment, useEffect, useMemo, useRef } from "react";
import { cx } from "../../ui/cx";
import { LinkIcon } from "../../ui/icons";
import type {
  GeneratedFileEntry,
  LineRange,
  ModelElementRef,
} from "../contract";
import { languageOf, tokenizePythonLine } from "../text";

export const MAX_RENDERED_LINES = 5000;

const RULE_KIND: Record<ModelElementRef["kind"], string> = {
  transition: "переход",
  variable: "переменная",
  requirement: "требование",
};

export function ruleLabel(ref: ModelElementRef): string {
  return `${RULE_KIND[ref.kind]} ${ref.id}`;
}

function rangeText(range: LineRange): string {
  return range.start === range.end
    ? `строка ${range.start}`
    : `строки ${range.start}–${range.end}`;
}

/**
 * Просмотр текста файла: номера строк, выделение диапазона, связи строк
 * с элементами модели и объяснения, вставленные после поясняемых строк.
 */
export function CodeViewer({
  entry,
  text,
  highlight,
  onHighlight,
  onRuleSelect,
}: {
  entry: GeneratedFileEntry;
  text: string;
  highlight: LineRange | null;
  onHighlight: (range: LineRange | null) => void;
  onRuleSelect?: ((ref: ModelElementRef) => void) | undefined;
}) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const shown = lines.slice(0, MAX_RENDERED_LINES);
  const python = languageOf(entry.path, entry.media_type) === "python";
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlight) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-line="${highlight.start}"]`,
    );
    target?.scrollIntoView?.({ block: "center" });
  }, [highlight, entry.path]);

  const rangedRefs = entry.elements
    .filter((e) => e.start_line >= 1 && e.end_line >= e.start_line)
    .map((e) => ({ ...e, lines: { start: e.start_line, end: e.end_line } }));

  return (
    <div className="pv-code">
      {entry.explanation && (
        <details className="pv-file-explanation">
          <summary>Назначение файла</summary>
          <p>{entry.explanation}</p>
          <p>Требования: {entry.requirement_ids.join(", ") || "не указаны"}</p>
        </details>
      )}
      {rangedRefs.length > 0 && (
        <div className="pv-code__refs" aria-label="Связи с моделью">
          {rangedRefs.map((ref) => (
            <span key={`${ref.kind}:${ref.id}`} className="pv-rule">
              <button
                type="button"
                className="pv-rule__lines"
                onClick={() => onHighlight(ref.lines!)}
              >
                {ref.id}{" "}
                <span className="pv-muted">{rangeText(ref.lines!)}</span>
              </button>
              {onRuleSelect && (
                <button
                  type="button"
                  className="pv-icon-button pv-rule__go"
                  onClick={() => onRuleSelect(ref)}
                  aria-label={`Показать ${ruleLabel(ref)} в модели`}
                  title="Показать в модели"
                >
                  <LinkIcon size={14} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div
        className="pv-code__scroll"
        ref={scrollRef}
        tabIndex={0}
        aria-label={`Содержимое ${entry.path}`}
      >
        <div className="pv-code__lines">
          {shown.map((line, index) => {
            const number = index + 1;
            const marked =
              highlight !== null &&
              number >= highlight.start &&
              number <= highlight.end;
            return (
              <Fragment key={number}>
                <div
                  className={cx("pv-line", marked && "is-marked")}
                  data-line={number}
                >
                  <span className="pv-line__no" aria-hidden="true">
                    {number}
                  </span>
                  <code className="pv-line__code">
                    {python
                      ? tokenizePythonLine(line).map((token, tokenIndex) =>
                          token.kind === "plain" ? (
                            <Fragment key={tokenIndex}>{token.text}</Fragment>
                          ) : (
                            <span
                              key={tokenIndex}
                              className={`pv-tok-${token.kind}`}
                            >
                              {token.text}
                            </span>
                          ),
                        )
                      : line}
                    {line === "" ? "​" : null}
                  </code>
                </div>
              </Fragment>
            );
          })}
        </div>
        {lines.length > MAX_RENDERED_LINES && (
          <p className="pv-note pv-code__cut">
            Показаны первые {MAX_RENDERED_LINES} строк из {lines.length}. Полный
            файл — в архиве.
          </p>
        )}
      </div>
    </div>
  );
}
