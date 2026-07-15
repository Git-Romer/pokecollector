with open('backend/models.py', 'a', encoding='utf-8') as f:
    f.write('''
class JohnJohnAuditLog(Base):
    __tablename__ = "john_john_audit_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    action_type = Column(String, nullable=False)
    payload = Column(JSON, nullable=False)
    reverted = Column(Boolean, default=False)
    created_at = Column(DateTime, default=func.now())


class JohnJohnNote(Base):
    __tablename__ = "john_john_notes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    kind = Column(String, nullable=False)
    title = Column(String, nullable=False)
    body = Column(Text, nullable=False)
    href = Column(String, nullable=True)
    undo_action_id = Column(Integer, ForeignKey("john_john_audit_log.id", ondelete="SET NULL"), nullable=True)
    dismissed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=func.now())

    audit_log = relationship("JohnJohnAuditLog")
''')
