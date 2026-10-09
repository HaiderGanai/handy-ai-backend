import { IsEnum } from 'class-validator';
import { DocumentType } from '../enums/document-type.enum';

export class UploadDocumentDto {
  @IsEnum(DocumentType)
  type: DocumentType;
}
