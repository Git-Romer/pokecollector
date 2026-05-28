def combine_binder_required_quantity(current_quantity: int, incoming_quantity: int) -> int:
    """Combine duplicate wishlist/deck binder CSV quantities.

    Binder required_quantity is capped at 99 everywhere else, so duplicate rows
    that intentionally represent multiple copies are summed only while the
    combined import quantity remains valid.
    """
    combined_quantity = current_quantity + incoming_quantity
    if combined_quantity > 99:
        raise ValueError("combined required_quantity for duplicate card must be between 1 and 99")
    return combined_quantity
