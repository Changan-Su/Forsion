// Register built-in block types (side-effect imports). Phase 1 ships markdown only.
import './markdown/MarkdownBlock'
// Register built-in database property types (todo / calendarDate) into the property-type registry.
import './database/propertyTypes.builtins'
