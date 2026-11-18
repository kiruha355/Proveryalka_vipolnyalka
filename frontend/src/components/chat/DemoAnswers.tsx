// Explicit presenter snippets for the order demo. They are drafts, never
// inferred answers to arbitrary user questions and never sent automatically.
export const ORDER_DEMO_ANSWERS = [
  { label: "Начальное состояние", text: "В начале процесса заявка новая: approved=false, cancelled=false, executed=false. Ни согласование, ни отмена, ни исполнение ещё не происходили." },
  { label: "Правила переходов", text: "Согласовать можно только заявку, у которой approved=false, cancelled=false и executed=false; согласование устанавливает approved=true. Отменить можно любую неисполненную заявку; отмена устанавливает cancelled=true и сохраняет approved. Исполнение разрешено, если approved=true, и устанавливает executed=true." },
  { label: "Критерий проверки", text: "Подтверждаю критерий: cancelled и executed не должны одновременно быть true. Это правило для проверки модели, а не дополнительное условие перехода исполнения." },
  { label: "Исправление исполнения", text: "Исправляю правило исполнения: выполнить заявку можно, только если approved=true и cancelled=false. Остальные правила оставь без изменений." },
] as const;

export function DemoAnswers({onChoose}: {onChoose(text: string): void}) {
  return <details className="demo-answers">
    <summary>Ответы для демонстрации</summary>
    <div className="answer-chips" role="group" aria-label="Вставить демо-ответ в сообщение">
      {ORDER_DEMO_ANSWERS.map(answer => <button key={answer.label} type="button" className="answer-chip"
        onClick={() => onChoose(answer.text)}>{answer.label}</button>)}
    </div>
  </details>;
}
