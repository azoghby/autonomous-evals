# Stable parent transport source

Final owner pin3f0bd8a589101c9902ad50d402b7948b6dee4c68 includes the committed parent
transport correction. transport.ts and original17regression/review artifacts are
preserved exactly from the authenticated owner tree; this owner patch does not target
transport.ts. Parent separately reported17regressions and156strict target tests.

Prior b331/384d snapshots intentionally excluded the then-uncommitted working change;
the final stable pin supersedes that seam. Do not revert or overlay the parent's
transport source. Later d6203b6 changes are a separately documented excluded delta;
no mutable-main chase or Git metadata writes occurred.
