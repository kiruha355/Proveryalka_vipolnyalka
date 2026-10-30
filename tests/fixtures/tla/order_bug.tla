---- MODULE Spec ----
EXTENDS Integers, TLC

VARIABLES v_status, v_approved, v_cancelled
vars == <<v_status, v_approved, v_cancelled>>

TypeOK ==
    /\ v_status \in {"Created", "Approved", "Cancelled", "Executed"}
    /\ v_approved \in BOOLEAN
    /\ v_cancelled \in BOOLEAN

Init ==
    /\ v_status = "Created"
    /\ v_approved = FALSE
    /\ v_cancelled = FALSE

\* Согласовать
t_Approve ==
    /\ (v_status = "Created")
    /\ v_status' = "Approved"
    /\ v_approved' = TRUE
    /\ UNCHANGED <<v_cancelled>>

\* Отменить
t_Cancel ==
    /\ ((v_status = "Created") \/ (v_status = "Approved"))
    /\ v_status' = "Cancelled"
    /\ v_cancelled' = TRUE
    /\ UNCHANGED <<v_approved>>

\* Исполнить
t_Execute ==
    /\ (v_approved = TRUE)
    /\ v_status' = "Executed"
    /\ UNCHANGED <<v_approved, v_cancelled>>

Next == t_Approve \/ t_Cancel \/ t_Execute
Spec == Init /\ [][Next]_vars

\* Сторожевые инварианты лимитов: их нарушение означает неполное исследование, а не ошибку модели.
LimitStates == TLCGet("distinct") <= 500
LimitDepth == TLCGet("level") <= 8

\* forbidden_state: Отменённая заявка не исполняется
p_NoCancelledExecution == ~(v_cancelled /\ (v_status = "Executed"))

\* reachable: Заявку можно исполнить
p_CanExecute == ~(v_status = "Executed")

\* deadlock_free: Завершение только отменой или исполнением
p_EndsProperly == ((v_status = "Cancelled") \/ (v_status = "Executed")) \/ (v_status = "Created") \/ ((v_status = "Created") \/ (v_status = "Approved")) \/ (v_approved = TRUE)
====
