# Closeté – Smart Wardrobe

Closeté is a web-based smart wardrobe application developed with Django. It helps users organize their digital wardrobe, create outfits, and manage their personal style plans.

## Features

- User authentication and account-based data management
- Digital wardrobe management
- Add, edit, archive, restore, and delete garments
- Upload and manage garment images
- Create, edit, and delete outfits
- Combine garments into personalized outfits
- Calendar-based outfit planning
- User preferences and settings
- Responsive user interface

## Technology Stack

- Python
- Django
- JavaScript
- HTML5
- CSS3
- SQLite (development)

## Project Structure

The project is organized into Django applications and frontend assets, including:

- `accounts/`
- `closet/`
- `templates/`
- `static/`
- `config/`

## Future Development

Planned improvements include:

- AI-powered outfit recommendations
- Intelligent clothing combination suggestions
- Context-aware styling recommendations

## Development Status

Closeté is currently a university project. The current version focuses on core smart wardrobe functionality and account-based data management.

## Running the Project Locally

1. Clone or download the repository.
2. Create and activate a Python virtual environment.
3. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

4. Configure the required environment variables.
5. Run database migrations:

   ```bash
   python manage.py migrate
   ```

6. Start the development server:

   ```bash
   python manage.py runserver
   ```

## Author

Developed as an academic software project.