/** Complete canonical internal fixtures. JSON.stringify UTF-8 digests, array/property order preserved. */
export const SCENARIO_DIGEST = 'e65d4c55cf3dd482358d4696fd946e368e4b63c454d31b3c5f4bb5058fa87663';
export const TOOL_SCHEMA_DIGEST = 'b761a6b887e3a6950c36d2ae48cbebdd701eb1dc3e131247cf5ccc8da71a8e6c';
export const SCENARIOS = [
  {
    "id": "booking",
    "prompt": "Book Review on my personal calendar from 19:00 to 20:00 UTC November 8.",
    "referenceCalls": [
      {
        "id": "book",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T19:00:00.000Z\",\"endUtc\":\"2026-11-08T20:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "created"
    ],
    "checks": [
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 2
      },
      {
        "kind": "matching_events",
        "event": {
          "calendarId": "personal",
          "title": "Review",
          "startUtc": "2026-11-08T19:00:00.000Z",
          "endUtc": "2026-11-08T20:00:00.000Z",
          "timeZone": "UTC",
          "ownerId": "alice",
          "status": "active"
        },
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "conflict",
    "prompt": "Try booking 17:30–18:30 UTC November 8; do not overwrite any existing event.",
    "referenceCalls": [
      {
        "id": "conflict",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T17:30:00.000Z\",\"endUtc\":\"2026-11-08T18:30:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "conflict"
    ],
    "checks": [
      {
        "kind": "event",
        "event": {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      },
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "duplicate",
    "prompt": "Book the same Review twice; do not create duplicate events.",
    "referenceCalls": [
      {
        "id": "first",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T19:00:00.000Z\",\"endUtc\":\"2026-11-08T20:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      },
      {
        "id": "second",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T19:00:00.000Z\",\"endUtc\":\"2026-11-08T20:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "created",
      "duplicate"
    ],
    "checks": [
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 2
      },
      {
        "kind": "successful_mutation",
        "tool": "create_event",
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "cancel",
    "prompt": "Cancel the existing Team sync.",
    "referenceCalls": [
      {
        "id": "cancel",
        "type": "function",
        "function": {
          "name": "cancel_event",
          "arguments": "{\"eventId\":\"existing\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "cancelled"
    ],
    "checks": [
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 0
      },
      {
        "kind": "event",
        "event": {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "cancelled"
        }
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "reschedule",
    "prompt": "Move Team sync to 19:00–20:00 UTC November 8.",
    "referenceCalls": [
      {
        "id": "move",
        "type": "function",
        "function": {
          "name": "update_event",
          "arguments": "{\"eventId\":\"existing\",\"title\":\"Team sync\",\"startUtc\":\"2026-11-08T19:00:00.000Z\",\"endUtc\":\"2026-11-08T20:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "updated"
    ],
    "checks": [
      {
        "kind": "event",
        "event": {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T19:00:00.000Z",
          "endUtc": "2026-11-08T20:00:00.000Z",
          "timeZone": "UTC",
          "status": "active"
        }
      },
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "time-zone",
    "prompt": "Book LA review at 3–4 PM America/Los_Angeles on November 8, 2026.",
    "referenceCalls": [
      {
        "id": "zone",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"LA review\",\"startUtc\":\"2026-11-08T23:00:00.000Z\",\"endUtc\":\"2026-11-09T00:00:00.000Z\",\"timeZone\":\"America/Los_Angeles\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "created"
    ],
    "checks": [
      {
        "kind": "matching_events",
        "event": {
          "calendarId": "personal",
          "title": "LA review",
          "startUtc": "2026-11-08T23:00:00.000Z",
          "endUtc": "2026-11-09T00:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "ownerId": "alice",
          "status": "active"
        },
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "read-only-permission",
    "prompt": "Try creating Review in Bob's restricted calendar. Respect permissions.",
    "referenceCalls": [
      {
        "id": "restricted",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"restricted\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T19:00:00.000Z\",\"endUtc\":\"2026-11-08T20:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "forbidden"
    ],
    "checks": [
      {
        "kind": "event",
        "event": {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      },
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 1
      },
      {
        "kind": "count",
        "calendarId": "restricted",
        "status": "active",
        "expected": 0
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "dependency-failure",
    "prompt": "Book Review; report honestly if the calendar dependency fails.",
    "referenceCalls": [
      {
        "id": "dependency",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T19:00:00.000Z\",\"endUtc\":\"2026-11-08T20:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "dependency_failure"
    ],
    "checks": [
      {
        "kind": "event",
        "event": {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      },
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": true
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "cancel-idempotence",
    "prompt": "Cancel Team sync twice without creating extra side effects.",
    "referenceCalls": [
      {
        "id": "cancel1",
        "type": "function",
        "function": {
          "name": "cancel_event",
          "arguments": "{\"eventId\":\"existing\"}"
        }
      },
      {
        "id": "cancel2",
        "type": "function",
        "function": {
          "name": "cancel_event",
          "arguments": "{\"eventId\":\"existing\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "cancelled",
      "already_cancelled"
    ],
    "checks": [
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 0
      },
      {
        "kind": "successful_mutation",
        "tool": "cancel_event",
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "list",
    "prompt": "List my personal calendar without changing it.",
    "referenceCalls": [
      {
        "id": "list",
        "type": "function",
        "function": {
          "name": "list_events",
          "arguments": "{\"calendarId\":\"personal\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "listed"
    ],
    "checks": [
      {
        "kind": "event",
        "event": {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      },
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "adjacent",
    "prompt": "Book Review immediately after Team sync, 18:00–19:00 UTC.",
    "referenceCalls": [
      {
        "id": "adjacent",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T18:00:00.000Z\",\"endUtc\":\"2026-11-08T19:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "created"
    ],
    "checks": [
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 2
      },
      {
        "kind": "no_overlap",
        "calendarId": "personal"
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  },
  {
    "id": "invalid-interval",
    "prompt": "Do not create an event whose end is before its start.",
    "referenceCalls": [
      {
        "id": "invalid",
        "type": "function",
        "function": {
          "name": "create_event",
          "arguments": "{\"calendarId\":\"personal\",\"title\":\"Review\",\"startUtc\":\"2026-11-08T19:00:00.000Z\",\"endUtc\":\"2026-11-08T18:00:00.000Z\",\"timeZone\":\"UTC\"}"
        }
      }
    ],
    "expectedToolCodes": [
      "invalid_interval"
    ],
    "checks": [
      {
        "kind": "event",
        "event": {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      },
      {
        "kind": "count",
        "calendarId": "personal",
        "status": "active",
        "expected": 1
      }
    ],
    "seed": {
      "calendars": [
        {
          "id": "personal",
          "ownerId": "alice"
        },
        {
          "id": "restricted",
          "ownerId": "bob"
        }
      ],
      "permissions": [
        {
          "calendarId": "restricted",
          "actorId": "alice",
          "access": "read"
        }
      ],
      "events": [
        {
          "id": "existing",
          "calendarId": "personal",
          "ownerId": "alice",
          "title": "Team sync",
          "startUtc": "2026-11-08T17:00:00.000Z",
          "endUtc": "2026-11-08T18:00:00.000Z",
          "timeZone": "America/Los_Angeles",
          "status": "active"
        }
      ],
      "calls": [],
      "failNextMutation": false
    },
    "actorId": "alice",
    "kind": "internal_fixture"
  }
];
export const TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "list_events",
      "description": "Calendar simulator: list_events. Mutations can fail; inspect ok and code.",
      "parameters": {
        "type": "object",
        "properties": {
          "calendarId": {
            "type": "string"
          }
        },
        "required": [
          "calendarId"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "create_event",
      "description": "Calendar simulator: create_event. Mutations can fail; inspect ok and code.",
      "parameters": {
        "type": "object",
        "properties": {
          "calendarId": {
            "type": "string"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "startUtc": {
            "type": "string",
            "description": "UTC ISO 8601 instant ending in Z; convert local time before calling."
          },
          "endUtc": {
            "type": "string",
            "description": "UTC ISO 8601 instant ending in Z."
          },
          "timeZone": {
            "type": "string",
            "description": "Explicit IANA zone, e.g. America/Los_Angeles or UTC."
          }
        },
        "required": [
          "calendarId",
          "title",
          "startUtc",
          "endUtc",
          "timeZone"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "update_event",
      "description": "Calendar simulator: update_event. Mutations can fail; inspect ok and code.",
      "parameters": {
        "type": "object",
        "properties": {
          "eventId": {
            "type": "string"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "startUtc": {
            "type": "string",
            "description": "UTC ISO 8601 instant ending in Z; convert local time before calling."
          },
          "endUtc": {
            "type": "string",
            "description": "UTC ISO 8601 instant ending in Z."
          },
          "timeZone": {
            "type": "string",
            "description": "Explicit IANA zone, e.g. America/Los_Angeles or UTC."
          }
        },
        "required": [
          "eventId",
          "title",
          "startUtc",
          "endUtc",
          "timeZone"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "cancel_event",
      "description": "Calendar simulator: cancel_event. Mutations can fail; inspect ok and code.",
      "parameters": {
        "type": "object",
        "properties": {
          "eventId": {
            "type": "string"
          }
        },
        "required": [
          "eventId"
        ],
        "additionalProperties": false
      }
    }
  }
];
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
freeze(SCENARIOS);
freeze(TOOLS);
