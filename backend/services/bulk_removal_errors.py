"""Owner-safe, machine-readable failures for atomic inventory requests."""
from fastapi.encoders import jsonable_encoder


def batch_detail(code, message, blockers, detail=None):
    return jsonable_encoder({**(detail or {}), 'code': code, 'message': message,
                             'changed': False, 'blockers': blockers})


def unavailable_blockers(requested_ids, accessible_ids, resource, **context):
    accessible = set(accessible_ids)
    return [{'code': 'not_found_or_not_accessible', 'resource': resource,
             'item_id': item_id, 'action': 'remove_from_request', **context}
            for item_id in requested_ids if item_id not in accessible]
