"""Правила переходов модели: условие (guard) и одновременное присваивание (effects).

Функции effects_* читают только состояние до события `s` и возвращают новые значения
присваиваемых переменных; остальные переменные не меняются. Правила меняются только через
новую согласованную версию модели и повторную генерацию."""
# Версия v_2a9cb60dcb45449a81b0149d445dea91, spec_hash a2021739f33d8b1933893d3f40096081cbbb249babd67a7d9eb769bb952efaaf, proveryalka-codegen 1.0.0
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Transition:
    id: str
    name: str
    requirement_ids: tuple
    assigns: tuple
    guard: Callable
    effects: Callable


# Переход Reserve «Резервирование товара»
# req_01189db190aa5159bdcdc73494608354: Reserve разрешён только из Draft при available>=2. Одновременно available уменьшается на 2, reserved становится 2, status становится Reserved.; req_588c5a93353c513eb5afb57508df4fb0: Все неуказанные пер…
def guard_Reserve(s):
    return (s['status'] == 'Draft') and (s['available'] >= 2)


def effects_Reserve(s):
    return {
        'available': s['available'] - 2,
        'reserved': 2,
        'status': 'Reserved',
    }


# Переход Pay «Оплата заказа»
# req_cedc5f58642c5065b13d45623abd271a: Pay разрешён только при status=Reserved и paid=false. Устанавливает paid=true.; req_588c5a93353c513eb5afb57508df4fb0: Все неуказанные переменные сохраняются.; req_48259ccb945e54d8989e4f57a0444772: Из C…
def guard_Pay(s):
    return (s['status'] == 'Reserved') and (s['paid'] == False)


def effects_Pay(s):
    return {
        'paid': True,
    }


# Переход Ship «Отгрузка товара»
# req_e15ae391f9305927803d48f74e33b06b: Ship разрешён только при status=Reserved, paid=true и reserved=2. Одновременно reserved=0, shipped=2, status=Shipped.; req_588c5a93353c513eb5afb57508df4fb0: Все неуказанные переменные сохраняются.; req…
def guard_Ship(s):
    return ((s['status'] == 'Reserved') and (s['paid'] == True)) and (s['reserved'] == 2)


def effects_Ship(s):
    return {
        'reserved': 0,
        'shipped': 2,
        'status': 'Shipped',
    }


# Переход Cancel «Отмена заказа»
# req_b7d1273bbb4a5e5fab60f9aec513dd0d: Cancel разрешён только при status=Reserved. Одновременно available=available+reserved, reserved=0 и status=Cancelled. Сумма available+reserved вычисляется по значениям до перехода. paid и shipped сохра…
def guard_Cancel(s):
    return s['status'] == 'Reserved'


def effects_Cancel(s):
    return {
        'available': s['available'] + s['reserved'],
        'reserved': 0,
        'status': 'Cancelled',
    }


TRANSITIONS = {
    'Reserve': Transition(
        id='Reserve',
        name='Резервирование товара',
        requirement_ids=('req_01189db190aa5159bdcdc73494608354', 'req_588c5a93353c513eb5afb57508df4fb0', 'req_48259ccb945e54d8989e4f57a0444772', 'req_7c99c5073dc851a4ae034766bc5a5a0e'),
        assigns=('available', 'reserved', 'status'),
        guard=guard_Reserve,
        effects=effects_Reserve,
    ),
    'Pay': Transition(
        id='Pay',
        name='Оплата заказа',
        requirement_ids=('req_cedc5f58642c5065b13d45623abd271a', 'req_588c5a93353c513eb5afb57508df4fb0', 'req_48259ccb945e54d8989e4f57a0444772', 'req_7c99c5073dc851a4ae034766bc5a5a0e'),
        assigns=('paid',),
        guard=guard_Pay,
        effects=effects_Pay,
    ),
    'Ship': Transition(
        id='Ship',
        name='Отгрузка товара',
        requirement_ids=('req_e15ae391f9305927803d48f74e33b06b', 'req_588c5a93353c513eb5afb57508df4fb0', 'req_48259ccb945e54d8989e4f57a0444772', 'req_7c99c5073dc851a4ae034766bc5a5a0e'),
        assigns=('reserved', 'shipped', 'status'),
        guard=guard_Ship,
        effects=effects_Ship,
    ),
    'Cancel': Transition(
        id='Cancel',
        name='Отмена заказа',
        requirement_ids=('req_b7d1273bbb4a5e5fab60f9aec513dd0d', 'req_588c5a93353c513eb5afb57508df4fb0', 'req_48259ccb945e54d8989e4f57a0444772', 'req_7c99c5073dc851a4ae034766bc5a5a0e'),
        assigns=('available', 'reserved', 'status'),
        guard=guard_Cancel,
        effects=effects_Cancel,
    ),
}
