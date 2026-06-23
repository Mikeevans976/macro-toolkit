#!/usr/bin/env python3
"""
Create or update a user in users.json.

Usage:
    python create_user.py <username> <password> [full_name]

Examples:
    python create_user.py admin admin123 "Admin User"
    python create_user.py alice secret123 "Alice Smith"
"""

import json
import os
import sys

import bcrypt

USERS_FILE = os.path.join(os.path.dirname(__file__), "users.json")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    username = sys.argv[1]
    password = sys.argv[2]
    full_name = sys.argv[3] if len(sys.argv) > 3 else username.capitalize()

    hashed_password = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

    # Load existing users
    if os.path.exists(USERS_FILE):
        with open(USERS_FILE, "r") as f:
            users = json.load(f)
    else:
        users = {}

    action = "Updated" if username in users else "Created"
    users[username] = {
        "username": username,
        "hashed_password": hashed_password,
        "full_name": full_name,
    }

    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)

    print(f"{action} user '{username}' in {USERS_FILE}")


if __name__ == "__main__":
    main()
