"""Explicit offline administrator command; never exposed through HTTP."""
import argparse
from ..storage.sqlite import SQLiteStore
from .access import assign_legacy

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--database',required=True)
    parser.add_argument('--email',required=True)
    args=parser.parse_args()
    store=SQLiteStore(args.database);store.initialize()
    print(f"Assigned {assign_legacy(store,args.email)} legacy sessions")

if __name__ == '__main__':
    main()
