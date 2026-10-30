"""Structural Agents SDK Session adapter backed by the API's single history."""
import asyncio


class StoredSession:
    session_settings = None

    def __init__(self, store, session_id):
        self.store = store
        self.session_id = session_id

    async def get_items(self, limit=None):
        return await asyncio.to_thread(self.store.history, self.session_id, limit)

    async def add_items(self, items):
        await asyncio.to_thread(self.store.append_messages, self.session_id, items)

    async def pop_item(self):
        return await asyncio.to_thread(self.store.pop_message, self.session_id)

    async def clear_session(self):
        await asyncio.to_thread(self.store.clear_history, self.session_id)
