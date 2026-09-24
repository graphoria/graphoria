-- Runs once, when the Postgres volume is first created. `docker compose down -v` resets it.
CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  published_year INT NOT NULL,
  author_id INT NOT NULL REFERENCES authors (id)
);

INSERT INTO authors (name) VALUES
  ('Ursula K. Le Guin'),
  ('Italo Calvino'),
  ('Octavia E. Butler');

INSERT INTO books (title, published_year, author_id) VALUES
  ('A Wizard of Earthsea', 1968, 1),
  ('The Left Hand of Darkness', 1969, 1),
  ('Invisible Cities', 1972, 2),
  ('If on a winter''s night a traveler', 1979, 2),
  ('Kindred', 1979, 3),
  ('Parable of the Sower', 1993, 3);
